var port = (process.env.VCAP_APP_PORT || 3000);
var express = require("express");
var mongoClient = require("mongodb").MongoClient;
var os = require("os-utils");
var async = require('async');
var moment = require('moment');


// Settings
var dbKeywordsCollection = "keywords";
var dbResultsCollection = "results";
var dbCacheCollection = "cache";

var sentiments = [];
var totalTweets = 0;


// defensiveness against errors parsing request bodies...
process.on('uncaughtException', function (err) {
    console.log('Caught exception: ' + err.stack);
});

// Configure the app web container
var app = express();
app.configure(function () {
    app.use(express.bodyParser());
    app.use(express.static(__dirname + '/public'));
});


// Database Connection
var mongo = {};
var keywordsCollection = null;
var cacheCollection = null;
var resultsCollection = null;

if (process.env.VCAP_SERVICES) {
    var env = JSON.parse(process.env.VCAP_SERVICES);

    if (env['mongodb-2.4']) {
        mongo['url'] = env['mongodb-2.4'][0]['credentials']['url'];
    }

    console.log("Mongo URL:" + mongo.url);
} else {
    console.log("No VCAP Services!");
    mongo['url'] = "mongodb://localhost:27017/ase";
}

var myDb;
var mongoConnection = mongoClient.connect(mongo.url, function (err, db) {

    if (!err) {
        console.log("Connection to mongoDB established");
        myDb = db;

        keywordsCollection = myDb.collection(dbKeywordsCollection);
        resultsCollection = myDb.collection(dbResultsCollection);
        cacheCollection = myDb.collection(dbCacheCollection);

        // Start the App after DB Connection
        startApp();

    } else {
        console.log("Failed to connect to database!");
    }
});

function startApp() {

    // Calculate sentiment for all keywords and wait 1 sec after completion.
    async.forever(
        function (done) {
            calculateSentimentForAllKeywords(function () {
                setTimeout(done, 1000);
            });
        },
        function (err) {
            if (err) {
                console.log("Error while calculating sentiment");
            }
        });

}


// REST API
app.get('/sentiment', function (req, res) {
    /*
     Delivers all phrases with score of last day
     */

    var response = {
        "tweets": totalTweets,
        "sentiments": sentiments
    };

    res.send(response);
});

app.get('/sentiment/:phrase/:start/:end', function (req, res) {
    /*
     Delivers JSON with results for specific dates
     */

    var phrase = req.params.phrase;
    var startDate = req.params.start;
    var endDate = req.params.end;

    var startDateISO = moment(startDate, "DD-MM-YYYY").toISOString();
    var endDateISO = moment(endDate, "DD-MM-YYYY").endOf('day').toISOString();

    getSentimentForPhrase(phrase, startDateISO, endDateISO, function (sentiment) {
        res.json(sentiment);
    });
});


app.post('/sentiment', function (req, res) {
    /*
     Adds new phrase for monitoring.
     */
    try {
        if (req.body.phrase) {

            var phrase = req.body.phrase;

            keywordsCollection.find({phrase: phrase}).toArray(function (err, docs) {
                if (docs.length > 0) {
                    console.log("Error: Phrase " + phrase + " already exists.");
                } else {
                    keywordsCollection.insert({phrase: phrase});
                    console.log("Added phrase " + phrase + ".");
                }
                res.send(200);
            });

        } else {
            res.status(400).send('Invalid request: send {"phrase": "ibm"}');
        }
    } catch (exception) {
        res.status(400).send('Invalid request: send {"phrase": "ibm"}');
    }
});

app.delete('/sentiment/:phrase', function (req, res) {
    /*
     Deletes phrase from monitoring.
     */
    var phrase = req.params.phrase;

    keywordsCollection.find({phrase: phrase}).toArray(function (err, docs) {
        if (docs.length > 0) {
            keywordsCollection.remove({phrase: phrase});
            console.log("Removed phrase " + phrase + ".");
        } else {
            console.log("Error: Phrase " + phrase + " not found.");
        }
        res.send(200);
    });
});


app.listen(port);
console.log("Server listening on port " + port);


//Functions
var calculateSentimentForAllKeywords = function (callback) {

    cacheCollection.aggregate([
            {
                $group: {
                    _id: "sum",
                    tweets: {$sum: "$tweets"}
                }
            }
        ],
        function (err, result) {

            if (result.length > 0)
                totalTweets = result[0].tweets;
            else
                totalTweets = 0;

            var startDate = moment().startOf('day').toISOString();
            var endDate = moment().endOf('day').toISOString();

            var result = [];
            keywordsCollection.find().sort({phrase: 1}).toArray(function (err, keywords) {
                if (keywords.length == 0) {
                    sentiments = [];
                    callback();
                } else {
                    async.eachSeries(keywords, function (keyword, callback) {
                        getSentimentForPhrase(keyword.phrase, startDate, endDate, function (sentiment) {
                            result.push(sentiment);
                            callback();
                        });
                    }, function (err) {
                        if (err) {
                            // One of the iterations produced an error.
                            // All processing will now stop.
                            console.log('A file failed to process');
                        } else {
                            sentiments = result;
                            callback();
                        }
                    });
                }
            });

        });
}

var getSentimentForPhrase = function (phrase, startDate, endDate, callback) {

    var averageUpperBound = 1.3;
    var averageLowerBound = -1.3;

    var scoreUpperBound = 1.0;
    var scoreLowerBound = 0.0;

    var singleScoreUpperBound = 5.0;
    var singleScoreLowerBound = -5.0;

    var findObject = {
        phrase: phrase,
        date: {
            $gte: startDate,
            $lt: endDate
        }
    };

    cacheCollection.find(findObject).sort({date: -1}).toArray(function (err, cacheEntries) {

        var tweets = 0;
        var totalsentiment = 0;
        var latestTweets = [];
        var history = [];

        // Calculate Score and History for each Day
        for (var i = 0; i < cacheEntries.length; i++) {
            var cacheEntry = cacheEntries[i];

            tweets += cacheEntry.tweets;
            totalsentiment += cacheEntry.totalsentiment;

            if (i == 0) {

                cacheEntry.latestTweets.forEach(function (tweet) {

                    var singleSentiment = tweet.sentiment;
                    if (singleSentiment > singleScoreUpperBound) singleSentiment = singleScoreUpperBound;
                    if (singleSentiment < singleScoreLowerBound) singleSentiment = singleScoreLowerBound;

                    // Map average to score between 0 and 1
                    tweet.score = ((singleSentiment - singleScoreLowerBound) / (singleScoreUpperBound - singleScoreLowerBound)) * (scoreUpperBound - scoreLowerBound) + scoreLowerBound;

                });

                latestTweets = cacheEntry.latestTweets;
            }


            var average = cacheEntry.totalsentiment / cacheEntry.tweets;

            // Limit average to bounds
            if (average > averageUpperBound) average = averageUpperBound;
            if (average < averageLowerBound) average = averageLowerBound;

            // Map average to score between 0 and 1
            var score = ((average - averageLowerBound) / (averageUpperBound - averageLowerBound)) * (scoreUpperBound - scoreLowerBound) + scoreLowerBound;

            cacheEntry.score = score;

            history.push(cacheEntry);
        }


        // Total Score
        var average = totalsentiment / tweets;

        // Limit average to bounds
        if (average > averageUpperBound) average = averageUpperBound;
        if (average < averageLowerBound) average = averageLowerBound;

        // Map average to score between 0 and 1
        var score = ((average - averageLowerBound) / (averageUpperBound - averageLowerBound)) * (scoreUpperBound - scoreLowerBound) + scoreLowerBound;

        var sentiment = {
            phrase: phrase,
            tweets: tweets,
            totalsentiment: totalsentiment,
            average: average,
            score: score,
            latestTweets: latestTweets,
            history: history
        };

        callback(sentiment);
    });
}
