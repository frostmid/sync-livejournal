process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var	_ = require ('lodash'),
	Promises = require ('vow'),
	SocketIO = require ('socket.io-client'),
	Slave = require ('fos-sync-slave'),
	LiveJournal = require ('./libs/livejournal'),
	url = process.argv [2] || 'http://127.0.0.1:8001';

function normalizeURL (url, ljStyle) {
	var tmp = url.match (/http:\/\/(.+).livejournal.com\/?(.+)?/),
		subDomain = tmp [1],
		queryUrl = tmp [2],
		resultUrl = url;

	if (ljStyle) {
		if (subDomain == 'www') {
			var tmp = url.match (/users\/([A-Za-z0-9-_]+)(?:\/(\d+).html(?:\?thread=(\d+))?)?/),
				journal = tmp [1],
				post = tmp [2],
				thread = tmp [3];

			resultUrl = 'http://' + journal + '.livejournal.com/';

			if (post) resultUrl += post + '.html';
			if (thread) resultUrl += '?thread=' + thread + '#t' + thread;
		}
	} else {
		if (subDomain != 'www') {
			resultUrl = 'http://www.livejournal.com/users/' + subDomain + '/' + (queryUrl || '');
		}

		resultUrl = resultUrl.replace(/&?#.*$/, '');
	}

	return resultUrl;
};

var parse = {
	'profile': function (entry) {
		return {
			'url': 'http://www.livejournal.com/users/' + entry.username + '/profile',
			'entry-type': 'urn:fos:sync:entry-type/62c4870f3c8a6aee0dd7e88e9e55958d',
			'first-name': entry.fullname,
			'nickname': entry.nickname,
			'content': entry.message || null,
			'avatar': entry.avatar || null,
			'birth-date': entry['birth-date'] || null,
			'city': entry.city || null,
			'site': entry.site || null,
			'alias': _.compact ([
				entry.facebook,
				entry.twitter,
				entry.vk,
				entry.ljtalk,
				entry.icq,
				entry.google,
				entry.skype,
				entry.email
			]),
			'show-url': 'http://' + entry.username + '.livejournal.com'
		};
	},

	'post': function (entry) {
		return {
			'url': normalizeURL (entry.url),
			'entry-type': 'urn:fos:sync:entry-type/62c4870f3c8a6aee0dd7e88e9e532848',
			'ancestor': entry.ancestor || null,
			'author': 'http://www.livejournal.com/users/' + entry.postername + '/profile',
			'title': entry.subject || null,
			'content': entry.event || null,
			'created_at': entry.event_timestamp,
			'metrics': {
				'comments': entry.reply_count || 0
			},
			'show-url': normalizeURL (entry.url, true)
		};
	},

	'comment': function (entry) {
		return {
			'url': normalizeURL (entry.url),
			'entry-type': 'urn:fos:sync:entry-type/62c4870f3c8a6aee0dd7e88e9e54463b',
			'ancestor': entry.ancestor || null,
			'author': 'http://www.livejournal.com/users/' + entry.postername + '/profile',
			'title': entry.subject || null,
			'content': entry.body || null,
			'created_at': entry.datepostunix,
			'metrics': {
				'comments': entry.reply_count || 0
			},
			'show-url': normalizeURL (entry.url, true)
		};
	},

	
};

function livejournal (slave, task, preEmit) {
	return new LiveJournal ({
		username: task._prefetch.token.username,
		password: task._prefetch.token.password,
		emit: function (entry) {
			if (preEmit) {
				entry = preEmit (entry);
			}
			
			return slave.emitter (task).call (this, entry);
		},
		scrapeStart: task['scrape-start'],
		parse: parse
	})
};

(new Slave ({
	title: 'livejournal api',
	version: '0.0.1'
}))

	.use ('urn:fos:sync:feature/62c4870f3c8a6aee0dd7e88e9e555af9', function resolveToken (task) {
		var token = task._prefetch.token;

		var preEmit = function (entry) {
			entry.tokens = [token._id];
			return entry;
		};

		return livejournal (this, task, preEmit).resolveToken ();
	})

	.use ('urn:fos:sync:feature/62c4870f3c8a6aee0dd7e88e9e512321', function getBlogPosts (task) {
		return livejournal (this, task).getBlogPosts (task.url);
	})

	.use ('urn:fos:sync:feature/62c4870f3c8a6aee0dd7e88e9e52f52d', function getPost (task) {
		return livejournal (this, task).getPost (task.url);
	})

	.use ('urn:fos:sync:feature/62c4870f3c8a6aee0dd7e88e9e578df8', function reply (task) {
		return livejournal (this, task).reply (task.url, task.content, task.issue);
	})

	.use ('urn:fos:sync:feature/03226920354111e3b6ba45cb1adeb5b6', function search (task) {
		return livejournal (this, task).search (task.url);
	})

	.use ('urn:fos:sync:feature/62c4870f3c8a6aee0dd7e88e9e54e708', function explain (task) {
		
		if (task.url.match(/(\d+).html\?thread=(\d+)/)) { //get Comment
			return livejournal (this, task).getComment (task.url);
		} else if(task.url.match(/(\d+).html$/)) { //get Post
			return livejournal (this, task).getPost (task.url);
		} else if (task.url.match(/users\/([A-Za-z0-9-_]+)(|\/)$/)) { //get getBlogPosts
			return livejournal (this, task).getBlogPosts (task.url);
		} else if (task.url.match(/users\/([A-Za-z0-9-_]+)\/profile/)) { //get Profile
			return livejournal (this, task).getProfile (task.url);
		} else {
			throw new Error ('None exist explain for url: ' + task.url);
		}
	})


	.fail (function (error) {
		console.error ('Error', error);

		var reconnect = _.bind (function () {
			this.connect (SocketIO, url)
		}, this);
		
		_.delay (reconnect, 1000);
	})

	.connect (SocketIO, url);