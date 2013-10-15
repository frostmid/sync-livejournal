var	_ = require ('lodash'),
	Promises = require ('vow'),
	xmlrpc = require('xmlrpc'),
	moment = require('moment'),
	cheerio = require('cheerio'),
	xmlParser = require('xml2js'),
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
		var tmp = url.match(/http:\/\/(.+).livejournal.com\/?(.+)?/),
			subDomain = tmp [1],
			queryUrl = tmp [2];

		if (subDomain != 'www') {
			url = 'http://www.livejournal.com/users/' + subDomain + '/' + (queryUrl || '');
		}

		url = url.replace(/&?#.*$/, '');

		return url;
	},

	xmlRPCRequest: function (method, params, path) {

		var promise = Promises.promise();

		var LJ = xmlrpc.createClient({
			host: 'livejournal.com',
			path: '/interface/xmlrpc',
			port: 80
		});

		LJ.Deserializer.prototype.endBase64 = function (data) {
			var buffer = new Buffer (data, 'base64');
			this.push (String (buffer));
			this.value = false;
		};

		rateLimit.promise((function (method, params, promise) {
			LJ.methodCall('LJ.XMLRPC.' + method, [params], function(error, results) {
				if (error) {
					return promise.reject (error);
				}

				return promise.fulfill (results);
			});
		}) (method, params, promise), 200);

		return promise;
	},

	get: function (method, params) {
		params = this._appendToken (params);
		params.ver = 1;
		return this.xmlRPCRequest (method, params);
	},

	reply: function (url, message, issue) {
		var self = this,
			tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/(\d+).html(\?thread=(\d+))?/),
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
					'username': tmp [1],
					'fullname': $ ('dl.b-profile-userinfo').first().find('dt:contains("Имя:") +').text() || $ ('h1.b-details-journal-title').text(),
					'avatar': $ ('.b-profile-userpic img').attr('src'),
					'nickname': $ ('.b-details-journal-ljuser .i-ljuser-username').text(),
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
			tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/(\d+).html\?thread=(\d+)/);

		var params = {
			'journal': tmp [1],
			'ditemid': tmp [2],
			'dtalkid': tmp [3],
			'selecttype': 'one',
			'expand_strategy': 'mobile_thread',
			'page_size': 100
		};

		return this.get ('getcomments', params)
			.then(function (result) {
				if (result.message) {
					throw new Error (result.message);
				}

				if (!result.comments.length) {
					throw new Error ('Non exist comment ' + url);
				}

				var entry = result.comments [0];
				entry.children = null;
				entry.url = url;

				entry.ancestor = self.settings.base + '/users/' + tmp [1] + '/' + tmp [2] + '.html' +
					(entry.parentdtalkid ? '?thread=' + entry.parentdtalkid : '');

				return Promises.when (self.entry (entry, 'comment'));
			});			
	},

	getComments: function (parent) {
		var self = this,
			parentURL = this.normalizeURL (parent.url),
			tmp = parentURL.match(/\/users\/([A-Za-z_0-9-]+)\/(\d+).html$/),
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

	getPost: function (url) {
		var tmp = url.match(/\/users\/([A-Za-z_0-9-]+)\/(\d+).html$/),
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

				if (!result.events.length) {
					throw new Error ('Non exist post ' + url);
				}

				var entry = result.events [0];
				entry.postername = params.journal;

				return Promises.all ([
					this.entry (entry, 'post'),
					this.getComments (entry, 'comment')
				]);

			}, this));
	},

	getBlogPosts: function (url) {
		return this.search ('http://www.livejournal.com/search/?q=%D1%81%D0%B8%D0%B0%D0%B1&ie=utf-8&area=default');

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

	search: function (url) {
		var self = this,
			tmp = url.match (/(?:\&|\?)q=(.+)&/),
			needle = tmp ? tmp [1] : null;

		if (!needle) {
			throw new Error ('Nothing to search');
		}

		return request ({url: 'http://blogs.yandex.ru/search.rss?server=livejournal.com&ft=all&text=' + needle})
			.then (function (body) {
				var promise = Promises.promise();
				console.log ('staaaaaaaaaaaaaaaaaaaaart');

				xmlParser.parseString (body, function (error, result) {
					console.log ('parseeeeeeeeeeeeeeeeeed');
					Promises.all([
						_.map (result['rss'].channel [0] .item, function (item) {
							var item_url = self.normalizeURL (item.link [0]);

							console.log ('hhhhhhhhhhhhhhhhh', item);

							if (item_url.match(/(\d+).html\?thread=(\d+)/)) { //get Comment
								console.log ('comeeeeeeeeeeeeeeeeeent');
								return self.getComment (item_url);
							} else if(item_url.match(/(\d+).html$/)) { //get Post
								console.log ('poooooooooooooooooost');
								return self.getPost (item_url);
							} else if (item_url.match(/users\/([A-Za-z0-9-_]+)\/profile/)) { //get Profile
								console.log ('profiiiiiiiiiiiiiiiile');
								return self.getProfile (item_url);
							} else {
								console.log ('errrrrrrrrrrrrrrrrrror');
								promise.reject ('Non inmplementation for: ' + item_url);
							}
						})
					]).then (function (result) {
						console.log ('resuuuuuuuuuuuuuuuuult');
						promise.fulfill (result);
					}).fail (function (error) {
						throw new Error (error);
					});
				});

				return promise;
			});
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

			return self.getProfile (self.settings.base + '/users/' + self.settings.username + '/profile');
		});
	}
});