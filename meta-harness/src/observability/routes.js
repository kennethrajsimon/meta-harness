// GET /v1/metrics       Prometheus text (default)
// GET /v1/metrics.json  JSON equivalent

const metrics = require('./metrics');
const prom = require('./prometheus');

function register(app) {
  app.route('GET', '/v1/metrics', (req, res) => {
    const snap = metrics.snapshot();
    const text = prom.serialize(snap);
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(text);
  });

  app.route('GET', '/v1/metrics.json', (req, res) => {
    app.json(res, 200, metrics.snapshot());
  });
}

module.exports = { register };
