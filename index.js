const fs = require('fs');
const path = require('path');
const util = require('util');
const yaml = require('js-yaml')
const axios = require('axios');
const assert = require('assert');
const {MongoClient} = require('mongodb');
const {Repository, Signature} = require('nodegit');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const dbName = process.argv[2] || 'esolang';
const dirName = process.argv[3] || '01';

(async () => {
	const usersData = yaml.safeLoad(await readFile('users.yml'));
	const usersMap = new Map(Object.entries(usersData));

	for (const [twitterName, githubName] of usersMap.entries()) {
		if (githubName === null) {
			usersMap.set(twitterName, {
				name: twitterName,
				email: `${twitterName}@twitter.com`,
			});
		} else {
			const {data} = await axios.get(`https://api.github.com/users/${githubName}/events${process.env.GITHUB_TOKEN ? `?access_token=${process.env.GITHUB_TOKEN}` : ''}`);
			const pushEvent = data.find((event) => event.type === 'PushEvent');
			const author = pushEvent.payload.commits[0].author;
			usersMap.set(twitterName, author);
			console.log(`Got author information for @${twitterName}`);
		}
	}

	const {data: githubLanguagesData} = await axios.get('https://raw.githubusercontent.com/github/linguist/master/lib/linguist/languages.yml');
	const githubLanguages = yaml.safeLoad(githubLanguagesData);

	const languagesData = yaml.safeLoad(await readFile('languages.yml'));

	const db = await MongoClient.connect(`mongodb://localhost:27017/${dbName}`);
	const users = await db.collection('users').find({}).toArray();
	const languages = await db.collection('languages').find({}).toArray();
	const submissions = await db.collection('submissions').find({status: 'success'}).sort({createdAt: 1}).toArray();
	db.close();

	const repo = await Repository.open(path.resolve(__dirname, './esolang-battle-archive'));

	for (const submission of submissions) {
		const submissionLanguage = languages.find((language) => language._id.equals(submission.language))
		assert(submissionLanguage);

		const extension = (() => {
			const slug = languagesData[submissionLanguage.slug] || submissionLanguage.slug;

			if (slug.startsWith('.')) {
				return slug;
			}

			const languageRegex = new RegExp(`^${slug}$`, 'i');
			const key = Object.keys(githubLanguages).find((language) => (
				language.match(languageRegex) || (language.aliases && language.aliases.any((alias) => alias.match(languageRegex)))
			));

			if (key) {
				return githubLanguages[key].extensions[0];
			}

			return `.${slug}`;
		})();

		const filename = `${submissionLanguage.slug}${extension}`;
		const pathname = path.join(__dirname, 'esolang-battle-archive', dirName, filename);
		await writeFile(pathname, submission.code);

		const submissionUser = users.find((user) => user._id.equals(submission.user))
		const submissionUserId = submissionUser.email.match(/^(.+?)@/)[1];
		const authorData = usersMap.get(submissionUserId);
		assert(authorData);

		const author = Signature.create(authorData.name, authorData.email, submission.createdAt.getTime() / 1000, 540);
		const committer = Signature.create(authorData.name, authorData.email, submission.createdAt.getTime() / 1000, 540);
		const commitId = await repo.createCommitOnHead([`${dirName}/${filename}`], author, committer, `Update ${filename}`);
	}
})().catch((error) => {
	console.error(error);
});
