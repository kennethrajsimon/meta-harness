// Aggregate audit-sourced usage into per-mission / per-agent summaries.
// Reads completion audit entries (which carry a `meter` block written by
// the orchestrator) and sums leaseHeldMs + estCostCents. Null costs are
// counted separately as `unmeteredCount`.

const audit = require('../audit/log');

function aggregate({ since, until, missionId, agent } = {}) {
  const entries = audit.readAll({
    since, until, missionId, agent,
    action: null,     // we filter by action below
    limit: 100000
  });

  const relevant = entries.filter(e => e.action === 'complete' && e.meter);

  const summary = {
    totalEvents: relevant.length,
    totalLeaseHeldMs: 0,
    totalEstCostCents: 0,
    unmeteredCount: 0,
    byAgent: {},      // agent -> {leaseHeldMs, estCostCents, count, unmeteredCount}
    byModel: {},      // model -> {...}
    byMission: {},    // missionId -> {...}
    byReason: {}      // estCostReason -> count
  };

  function bump(bucket, key, e) {
    if (!bucket[key]) bucket[key] = { leaseHeldMs: 0, estCostCents: 0, count: 0, unmeteredCount: 0 };
    const b = bucket[key];
    b.leaseHeldMs += e.meter.leaseHeldMs || 0;
    b.count += 1;
    if (e.meter.estCostCents == null) b.unmeteredCount += 1;
    else b.estCostCents += e.meter.estCostCents;
  }

  for (const e of relevant) {
    summary.totalLeaseHeldMs += e.meter.leaseHeldMs || 0;
    if (e.meter.estCostCents == null) summary.unmeteredCount += 1;
    else summary.totalEstCostCents += e.meter.estCostCents;

    if (e.meter.agent) bump(summary.byAgent, e.meter.agent, e);
    if (e.meter.model) bump(summary.byModel, e.meter.model, e);
    if (e.missionId)   bump(summary.byMission, e.missionId, e);
    const reason = e.meter.estCostReason || 'unknown';
    summary.byReason[reason] = (summary.byReason[reason] || 0) + 1;
  }

  // Round aggregate costs for presentation.
  summary.totalEstCostCents = Math.round(summary.totalEstCostCents * 10000) / 10000;
  for (const bucket of [summary.byAgent, summary.byModel, summary.byMission]) {
    for (const k of Object.keys(bucket)) {
      bucket[k].estCostCents = Math.round(bucket[k].estCostCents * 10000) / 10000;
    }
  }

  summary.currency = 'USD-cents';
  summary.methodology = 'time_based_estimate';
  summary.disclaimer = 'Cost is leaseHeldMs × modelRate. Not real tokens; upgrade when Claude CLI exposes usage.';
  return summary;
}

module.exports = { aggregate };
