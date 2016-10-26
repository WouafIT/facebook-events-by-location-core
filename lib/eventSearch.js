"use strict";

var Promise = require("bluebird");
var rp = require("request-promise");
var path = require("path");
var fs = require("fs");

var schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../", "schema", "events-response.schema.json"), "utf8"));

var EventSearch = function (options) {
    var self = this,
        allowedSorts = ["time", "distance", "venue", "popularity"];

    self.latitude = options.lat || null;
    self.longitude = options.lng || null;
    self.distance = options.distance || 100;
    self.accessToken = options.accessToken ? options.accessToken : (process.env.FEBL_ACCESS_TOKEN && process.env.FEBL_ACCESS_TOKEN !== "" ? process.env.FEBL_ACCESS_TOKEN : null);
    self.query = options.query ? encodeURIComponent(options.query) : "";
    self.sort = options.sort ? (allowedSorts.indexOf(options.sort.toLowerCase()) > -1 ? options.sort.toLowerCase() : null) : null;
    self.version = options.version ? options.version : "v2.8";
    self.schema = schema;

    self.venues = [];
    self.events = [];
    self.locations = {};
    self.eventLocations = {};
    self.venuesCount = 0;
    self.venuesWithEvents = 0;
    self.eventsCount = 0;
    self.recurse = false;
    self.idLimit = 50; //FB only allows 50 ids per /?ids= call
    self.currentTimestamp = (new Date().getTime()/1000).toFixed();
};

EventSearch.prototype.getIds = function(responseBody) {
    var self = this,
        ids = [],
        tempArray = [],
        data = (typeof responseBody === 'object' ? responseBody : JSON.parse(responseBody).data);

    //Set venueCount
    self.venuesCount += data.length;

    //Create array of 50 places each
    data.forEach(function(idObj, index, arr) {
        var id = (typeof idObj === 'object') ? idObj.id : idObj;
        if (id) {
            tempArray.push(id);
            if (tempArray.length >= self.idLimit) {
                ids.push(tempArray);
                tempArray = [];
            }
        }
    });

    // Push the remaining places
    if (tempArray.length > 0) {
        ids.push(tempArray);
    }

    return ids;
};

EventSearch.prototype.getEventsUrls = function(ids) {
    var self = this,
        urls = [];

    //Create a Graph API request array (promisified)
    ids.forEach(function(idArray, index, arr) {
        urls.push(rp.get("https://graph.facebook.com/" + self.version + "/?ids=" + idArray.join(",") + "&fields="+
                         "id,name,about,emails,link,username,category_list,"+
                         "cover.fields("+
                            "id,source"+
                         "),picture.type("+
                            "large"+
                         "),location,"+
                         "events.fields("+
                            "id,type,name,"+
                             "cover.fields("+
                                "id,source"+
                             "),picture.type("+
                                "large"+
                             "),"+
                             "description,start_time,end_time,attending_count,declined_count,maybe_count,noreply_count,"+
                             "admins.fields("+
                                "name,id,profile_type"+
                             ")"+
                         ").since(" + self.currentTimestamp + ")&access_token=" + self.accessToken));
    });

    return urls;

};

EventSearch.prototype.resolveRequests = function(promisifiedRequests) {

    //Run Graph API requests in parallel
    return Promise.all(promisifiedRequests)

};

EventSearch.prototype.aggregateEvents = function(results){
    var self = this,
        ids = [];
    //Handle results
    results.forEach(function(resStr, index, arr) {
        var resObj = JSON.parse(resStr);
        Object.getOwnPropertyNames(resObj).forEach(function(venueId, index, array) {
            var venue = resObj[venueId];
            self.venues.push(venueId);
            if (venue.events && venue.events.data.length > 0) {
                if (venue.location) {
                    self.locations[venueId] = venue.location;
                }
                self.venuesWithEvents++;
                venue.events.data.forEach(function(event, index, array) {
                    if (venue.location) {
                        self.eventLocations[event.id] = venueId;
                    } else {
                        if (self.eventLocations[event.id]) {
                            venue.location = self.locations[self.eventLocations[event.id]];
                        } else {
                            return;
                        }
                    }
                    //check if event has the venue as admin
                    var is_admin = false;
                    if (event.admins) {
                        for (var i = 0, l = event.admins.data.length; i < l; i++) {
                            var adminId = event.admins.data[i].id;
                            if (adminId === venueId) {
                                is_admin = true;
                            } else
                                if (event.admins.data[i].profile_type === 'page' &&
                                    self.venues.indexOf(adminId) === -1 &&
                                    ids.indexOf(adminId) === -1) {

                                    ids.push(adminId);
                                }
                        }
                    }
                    if (is_admin) {
                        var eventResultObj = {};
                        eventResultObj.id = event.id;
                        eventResultObj.name = event.name;
                        eventResultObj.type = event.type;
                        eventResultObj.coverPicture = (event.cover ? event.cover.source : null);
                        eventResultObj.profilePicture = (event.picture ? event.picture.data.url : null);
                        eventResultObj.description = (event.description ? event.description : null);
                        eventResultObj.startTime = (event.start_time ? event.start_time : null);
                        eventResultObj.endTime = (event.end_time ? event.end_time : null);
                        eventResultObj.stats = {
                            attending: event.attending_count,
                            declined: event.declined_count,
                            maybe: event.maybe_count,
                            noreply: event.noreply_count
                        };
                        eventResultObj.venue = {};
                        eventResultObj.venue.id = venueId;
                        eventResultObj.venue.name = venue.name;
                        eventResultObj.venue.about = (venue.about ? venue.about : null);
                        eventResultObj.venue.categories = (venue.category_list ? venue.category_list : null);
                        eventResultObj.venue.link = (venue.link ? venue.link : null);
                        eventResultObj.venue.username = (venue.username ? venue.username : null);
                        eventResultObj.venue.emails = (venue.emails ? venue.emails : null);
                        eventResultObj.venue.coverPicture = (venue.cover ? venue.cover.source : null);
                        eventResultObj.venue.profilePicture = (venue.picture ? venue.picture.data.url : null);
                        eventResultObj.venue.location = venue.location;
                        self.events.push(eventResultObj);
                        self.eventsCount++;
                    }
                });
            }
        });
    });
    //get and append all missing places
    return new Promise(function (resolve, reject) {
        if (ids.length && !self.recurse) {
            self.recurse = true;
            var p = new Promise(function (resolve, reject) {
                ids = (self.getIds.bind(self, ids))();
                resolve(ids);
            });
            p.then(self.getEventsUrls.bind(self))
                .then(self.resolveRequests.bind(self))
                .then(self.aggregateEvents.bind(self))
                .then(function() {
                    resolve();
                }).catch(function (e) {
                    var error = {
                        "message": e,
                        "code": -1
                    };
                    reject(error);
                });
        } else {
            resolve();
        }
    });
};

EventSearch.prototype.search = function () {
    var self = this;

    return new Promise(function (resolve, reject) {

        if (!self.latitude || !self.longitude) {
            var error = {
                "message": "Please specify the lat and lng parameters!",
                "code": 1
            };
            reject(error);
        } else if (!self.accessToken) {
            var error = {
                "message": "Please specify an Access Token, either as environment variable or as accessToken parameter!",
                "code": 2
            };
            reject(error);
        } else {
            var placeUrl = "https://graph.facebook.com/" + self.version + "/search?"+
                           "type=place&q=" + self.query + "&center=" + self.latitude + "," + self.longitude + "&distance=" + self.distance + "&limit=1000"+
                           "&fields=id&access_token=" + self.accessToken;

            //Get places as specified
            rp.get(placeUrl)
                .then(self.getIds.bind(self))
                .then(self.getEventsUrls.bind(self))
                .then(self.resolveRequests.bind(self))
                .then(self.aggregateEvents.bind(self))
                .then(function () {
                    resolve({events: self.events, metadata: {venues: self.venuesCount, venuesWithEvents: self.venuesWithEvents, events: self.eventsCount}});
                }.bind(self))
                .catch(function (e) {
                    var error = {
                        "message": e,
                        "code": -1
                    };
                    reject(error);
                });
        }

    });

};

EventSearch.prototype.getSchema = function () {
    return this.schema;
};

module.exports = EventSearch;
