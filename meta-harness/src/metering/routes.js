// GET /v1/usage                    aggregate across everything (or filtered)
// GET /v1/missions/:id/usage       per-mission aggregate
// GET /v1/metering/rates           current rate table (read-only)

const url = require('url');
const ledger = require('./ledger');
const rates = require('./rates');

function register(app) {
  app.route('GET', '/v1/usage', (req, res) => {
    const q = url.parse(req.url, true).query;
    const summary = ledger.aggregate({
      since: q.since, until: q.until,
      missionId: q.mission, agent: q.agent
    });
    app.json(res, 200, summary);
  });

  app.route('GET', '/v1/missions/:id/usage', (req, res, params) => {
    const summary = ledger.aggregate({ missionId: params.id });
    app.json(res, 200, summary);
  });

  app.route('GET', '/v1/metering/rates', (req, res) => {
    app.json(res, 200, rates.load());
  });
}

module.exports = { register };
