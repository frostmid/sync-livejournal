var	_ = require ('lodash'),
	Promises = require ('vow'),
	xmlrpc = require('xmlrpc'),
	moment = require('moment'),
	cheerio = require('cheerio'),
	rateLimit = require ('fun-rate-limit'),
	request = rateLimit.promise (require ('fos-request'), 200);


module.exports = function LiveJournal (settings) {
	this.settings = _.extend ({}, this.settings, settings);
	this.entry = _.bind (this.entry, this);
};

_.extend (module.exports.prototype, {
	settings: {
		base: 'http://www.livejournal.com',
		locale: 'ru_RU',
		username: null,
		password: null,
		emit: null,
		scrapeStart: null
	},

	normalizeURL: function (url) {
		var tmp = url.match(/http:\/\/(.+).livejournal.com(\/?(.+))?/),
			subDomain = tmp [1],
			queryUrl = tmp [3];

		if (subDomain != 'www') {
			url = 'http://www.livejournal.com/users/' + subDomain + '/';
			
	      	if (queryUrl) {
				if (queryUrl.match(/(\d+).html/)) {
					url += 'read/' + queryUrl;
				} else {
					url += queryUrl;
				}
	        }
		}

		url = url.replace(/&?#.*$/, '');

		return url;
	},

	xmlRPCRequest: function (method, params) {
		var promise = Promises.promise();

		var LJ = xmlrpc.createClient({
			host: 'livejournal.com',
			path: '/interface/xmlrpc',
			port: 80
		});

		LJ.Deserializer.prototype.endBase64 = function(data) {
			var buffer = new Buffer(data, 'base64');
			this.push(String(buffer));
			this.value = false;
		};

		LJ.methodCall('LJ.XMLRPC.' + method, [params], function(error, results) {
			if (error) {
				return promise.reject (error);
			}

			return promise.fulfill (results);
		});

		return promise;
	},

	get: function (method, params) {
		params = this._appendToken (params);
		params.ver = 1;
		return this.xmlRPCRequest (method, params);
	},

	post: function (endpoint, data) {
		var url = this._appendToken (this.settings.base + endpoint);
		return this.xmlRPCRequest ({
			url: url,
			method: 'post',
			form: data
		});	
	},

	getPost: function (url) {
		var tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/read\/(\d+).html$/),
			params = {
				'journal': tmp [1],
				'ditemid': tmp [2],
				'selecttype': 'one'
			};

		return this.get ('getevents', params)
			.then(_.bind(function (result) {
				if (result.message) {
					throw new Error (result.message);
				}

				var entry = result.events [0];
				entry.postername = params.journal;

				return Promises.all ([
					this.entry (entry, 'post'),
					this.getComments (entry, 'comment')
				]);

			}, this));
	},

	reply: function (url, message, issue) {
		var self = this,
			tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/read\/(\d+).html(\?thread=(\d+))?/),
			params = {
				'journal': tmp [1],
				'ditemid': tmp [2],
				'parenttalkid': parseInt (tmp [4] / 256) || null,
				'replyto': tmp [4] || null,
				'body': message
			};

		return this.get ('addcomment', params)
			.then(_.bind(function (result) {
				if (result.message) {
					throw new Error (result.message);
				}
				
				if (result.status == 'OK') {
					var entry = {
						url: result.commentlink,
						ancestor: url,
						postername: this.settings.username,
						subject: '',
						body: message,
						datepostunix: parseInt(Date.now() / 1000),
						reply_count: 0,
						issue: issue
					};
					
					self.entry (entry, 'comment');
				} else {
					throw new Error ('Message was not send');
				}
			}, this));
	},

	getProfile: function (url) {
		var self = this,
			tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/profile$/);

		return request ({url: 'http://' + tmp [1] + '.livejournal.com/profile'})
			.then (function (body) {
				var $ = cheerio.load (body);

				return {
					'url': url,
					'fullname': $ ('dl.b-profile-userinfo').first().find('dt:contains("Имя:") +').text() || $ ('h1.b-details-journal-title').text(),
					'avatar': $ ('.b-profile-userpic img').attr('src'),
					'username': $ ('.b-details-journal-ljuser .i-ljuser-username').text(),
					'city': $ ('dl.b-profile-userinfo').first().find('.locality').text() || null,
					'site': $ ('dl.b-profile-userinfo').first().find('dt:contains("Сайт:") +').find('a').attr('href') || null,
					'email': $ ('dl.b-profile-userinfo').first().find('.b-contacts-mail').text() || null,
					'facebook': $ ('dl.b-profile-userinfo').first().find('.b-contacts-facebook').text() || null,
					'twitter': $ ('dl.b-profile-userinfo').first().find('.b-contacts-twitter').text() || null,
					'vk': $ ('dl.b-profile-userinfo').first().find('.b-contacts-vk').text() || null,
					'ljtalk': $ ('dl.b-profile-userinfo').first().find('.b-contacts-ljtalk').text() || null,
					'icq': $ ('dl.b-profile-userinfo').first().find('.b-contacts-icq').text() || null,
					'google': $ ('dl.b-profile-userinfo').first().find('.b-contacts-google').text() || null,
					'skype': $ ('dl.b-profile-userinfo').first().find('.b-contacts-skype').text() || null

					//'birth-date': $ ('dl.b-profile-userinfo').first().find('dt:contains("Дата рождения:") +').text() ||, //TODO: date parse
				};
			})
			.then (function (entry) {
				return Promises.when (self.entry (entry, 'profile'));
			});
	},

	getComment: function (url) {
		var self = this,
			tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/read\/(\d+).html\?thread=(\d+)/),
			journal = tmp [1],
			postId = tmp [2],
			commentId = tmp [3],
			requestUrl = 'http://' + journal + '.livejournal.com/' + postId + '.html?thread=' + commentId;

		return request ({url: requestUrl})
			.then (function (body) {
				var $ = cheerio.load (body),
					data = JSON.parse ($ ('script#comments_json').text ()),
					ancestor = self.settings.base + '/users/' + journal + '/read/' + postId + '.html';

				var entry = _.find (data, function (item) {
					return item.dtalkid == commentId;
				});

				var parent = _.find (data, function (item) {
					return item.dtalkid = entry.parent;
				});

				if (parent)
					ancestor += '?thread=' + parent.dtalkid;

				return {
					'url': url,
					'ancestor': ancestor,
					'postername': entry.dname,
					'subject': null,
					'body': entry.article,
					'datepostunix': entry.ctime_ts,
					'reply_count': 0
				};
			})
			.then (function (entry) {
				return Promises.when (self.entry (entry, 'comment'));
			});
	},

	getComments: function (parent) {
		var self = this,
			parentURL = this.normalizeURL (parent.url),
			tmp = parentURL.match(/\/users\/([A-Za-z_0-9-]+)\/read\/(\d+).html$/),
			params = {
				'journal': tmp [1],
				'ditemid': tmp [2],
				'selecttype': null,
				'expand_strategy': 'mobile_thread',
				'page_size': 100
			};

		var flattenComment = function (entry, result) {
			if (!result) result = [];

			if (entry.children && entry.children.length) {
				entry.reply_count = entry.children.length;

				_.forEach (entry.children, _.bind(function (child) {
					child.ancestor = parentURL + '?thread=' + entry.dtalkid;
					result = flattenComment (child, result);
				}, this));
			}

			if (!entry.ancestor) 
				entry.ancestor = parentURL;

			entry.url = parentURL + '?thread=' + entry.dtalkid;
			entry.children = null;
			result.push (entry);

			return result;
		};

		return this.list ('getcomments', params, function (entry) {
			_.forEach (flattenComment (entry), function (item) {
				self.entry (item, 'comment');
			});
		});
	},

	getBlogPosts: function (url) {

		return this.getComments ({url: 'http://www.livejournal.com/users/ibigdan/read/13788379.html'});

		var tmp = url.match(/\/users\/([A-Za-z_0-9-]+)$/),
			params = {
				'journal': tmp [1],
				'lastsync': moment (this.settings.scrapeStart).format("YYYY-MM-DD HH:mm:ss"),
				'selecttype': 'lastn',
				'howmany': 50
			};

		return this.list ('getevents', params, _.bind(function (entry) {

			entry.postername = params.journal;

			return Promises.all ([
				this.entry (entry, 'post'),
				this.getComments (entry, 'comment')
			]);
		}, this));
	},

	list: function (method, params, iterator) {
		var self = this;

		var fetchMore = _.bind (function (method, params) {
			return this.xmlRPCRequest (method, params)
				.then (process);
		}, this);

		var process = function (results) {
			var promises = [];

			if (results.error) {
				throw results.error;
			}

			if (method == 'getcomments') {
				if (results.topitems) {
					promises = _.map (
						_.filter (results.comments, function (entry) {
							var created_time = entry.datepostunix || null,
								scrapeStart = self.settings.scrapeStart / 1000;

							return (created_time && scrapeStart && (created_time >= scrapeStart));
						}),
						iterator
					);
				}

				if (results.pages && (results.pages > results.page)) {
					params.page = params.page ? params.page + 1 : 2;

					promises.push (
						fetchMore (method, params)
					);
				}
			} else if (method == 'getevents') {
				if (results.events && results.events.length) {
					promises = _.map (
						_.filter (results.events, function (entry) {
							var created_time = entry.event_timestamp || null,
								scrapeStart = self.settings.scrapeStart / 1000;

							return (created_time && scrapeStart && (created_time >= scrapeStart));
						}),
						iterator
					);


					params.skip = params.skip ? params.skip + 50 : 50;

					promises.push (
						fetchMore (method, params)
					);
				}
			}

			return Promises.all (promises);
		};

		return this.get (method, params)
			.then (process);
	},

	entry: function (entry, type) {
		var parser = this.settings.parse [type],
			parsed;

		if (typeof parser == 'function') {
			try {
				parsed = parser.call (this, entry);
			} catch (e) {
				console.error ('Failed to parse entry', e.message, entry);
				throw e;
			}

			console.log('* emit', parsed.url);
			
			return Promises.when (parsed)
				.then (this.settings.emit)
				.fail (function (error) {
					console.log ('Failed to emit entry', error, entry);
				})
				.done ();
		} else {
			console.log ('Skipping of unknown type', type);
		}
	},

	_appendToken: function (params) {
		params.username = this.settings.username;
		params.password = this.settings.password;
		params.auth_method = 'clear';
		
		return params;
	},

	resolveToken: function () {
		var self = this;

		return this.xmlRPCRequest ('login', {
			'username': this.settings.username,
			'password': this.settings.password,
			'auth_method': 'clear'
		})
		.then (function (entry) {
			if(entry.message) {
				throw new Error (entry.message);
			}

			return Promises.when (self.entry (entry, 'profile'));
		});
	}
});