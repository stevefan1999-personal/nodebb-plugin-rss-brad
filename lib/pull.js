'use strict';

const winston = require.main.require('winston');
const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const topics = require.main.require('./src/topics');
const user = require.main.require('./src/user');
const TurndownService = require('turndown');
const axios = require('axios');
const cheerio = require('cheerio');

const feedAPI = require('./feed');

var turndownService = new TurndownService();

const Pulling = module.exports;

Pulling.pullFeed = async function pullFeed(feed) {
	if (!feed) {
		return;
	}

	try {
		const entries = await feedAPI.getItems(feed.url, feed.entriesToPull);
		entries.reverse();
		for (const entry of entries) {
			// eslint-disable-next-line no-await-in-loop
			await postEntry(feed, entry);
		}
	} catch (err) {
		winston.error(`[unable to pull feed] ${feed.url}`, err);
	}
};

function getEntryDate(entry) {
	if (!entry) {
		return null;
	}
	return entry.published || entry.date || entry.updated || Date.now();
}

async function isEntryNew(feed, entry) {
	const uuid = entry.id || (entry.link && entry.link.href) || entry.title;
	const isMember = await db.isSortedSetMember(`nodebb-plugin-rss-brad:feed:${feed.url}:uuid`, uuid);
	return !isMember;
}

async function postEntry(feed, entry) {
	if (!entry || (!entry.hasOwnProperty('link') || !entry.link || !entry.link.href)) {
		winston.warn(`[nodebb-plugin-rss-brad] invalid link for entry,  ${feed.url}`);
		return;
	}

	if (!entry.title || typeof entry.title !== 'string') {
		winston.warn(`[nodebb-plugin-rss-brad] invalid title for entry, ${feed.url}`);
		return;
	}

	const isNew = await isEntryNew(feed, entry);
	if (!isNew) {
		winston.info(`[plugin-rss-brad] entry is not new, id: ${entry.id}, title: ${entry.title}, link: ${entry.link && entry.link.href}`);
		return;
	}

	let posterUid = await user.getUidByUsername(feed.username);
	if (!posterUid) {
		posterUid = 1;
	}

	let tags = [];
	if (feed.tags) {
		tags = feed.tags.split(',');
	}

	// use tags from feed if there are any
	if (Array.isArray(entry.tags)) {
		const entryTags = entry.tags.map(data => data && data.term).filter(Boolean);
		tags = tags.concat(entryTags);
	}

    // Fetch and parse webpage content
    let content = '';
    try {
        const response = await axios.get(entry.link.href);
        const $ = cheerio.load(response.data);
        const webpageContent = $('.entry-content.gridmode-clearfix').html(); // Adjust this selector based on the actual structure
        content = turndownService.turndown(webpageContent);
    } catch (error) {
        winston.error(`[plugin-rss-brad] failed to fetch webpage content, ${entry.link.href}`, error);
        content = ''; // Fallback content or handle the error appropriately
    }

	winston.info(`[plugin-rss-brad] posting, ${feed.url} - title: ${entry.title}, published date: ${getEntryDate(entry)}`);

	const result = await topics.post({
		uid: posterUid,
		title: entry.title,
		content: `${content || ""}\n\nVia: ${entry.link && entry.link.href}`,
		cid: feed.category,
		tags: tags,
	});

	const { topicData } = result;

	if (feed.timestamp === 'feed') {
		setTimestampToFeedPublishedDate(result, entry);
	}

	const max = Math.max(parseInt(meta.config.postDelay, 10) || 10, parseInt(meta.config.newbiePostDelay, 10) || 10) + 1;

	await user.setUserField(posterUid, 'lastposttime', Date.now() - (max * 1000));
	const uuid = entry.id || (entry.link && entry.link.href) || entry.title;
	await db.sortedSetAdd(`nodebb-plugin-rss-brad:feed:${feed.url}:uuid`, topicData.tid, uuid);
}

function setTimestampToFeedPublishedDate(data, entry) {
	const { topicData } = data;
	const { postData } = data;
	const { tid } = topicData;
	const { pid } = postData;
	const timestamp = new Date(getEntryDate(entry)).getTime();

	db.setObjectField(`topic:${tid}`, 'timestamp', timestamp);
	db.sortedSetsAdd([
		'topics:tid',
		`cid:${topicData.cid}:tids`,
		`cid:${topicData.cid}:uid:${topicData.uid}:tids`,
		`uid:${topicData.uid}:topics`,
	], timestamp, tid);

	db.setObjectField(`post:${pid}`, 'timestamp', timestamp);
	db.sortedSetsAdd([
		'posts:pid',
		`cid:${topicData.cid}:pids`,
	], timestamp, pid);
}
