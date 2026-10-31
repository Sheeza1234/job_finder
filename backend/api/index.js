// Vercel entry point: wraps the Express app as one serverless function. Unlike `npm start` there is no listening
// server, no background scheduler and no persistent disk, so uploads live in /tmp and are not kept between invocations.
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/jobfinder';
process.env.SCHEDULER = 'off';
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let appPromise;
module.exports = async (req, res) => {
  appPromise = appPromise || openDb().then((db) => createApp(db)).catch((e) => { appPromise = null; throw e; });
  try { (await appPromise)(req, res); }
  catch (e) { res.statusCode = 500; res.end(`Could not connect to the database: ${e.message}`); }
};
