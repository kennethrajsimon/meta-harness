// Capability router: rank agents for a given task phrase using tf-idf over
// the union of their declared capabilities + manifest keywords.
// Pure function, no deps. Good enough for a corpus of ~50 agents.

const store = require('../registry/store');

const PEER_PENALTY = parseFloat(process.env.MH_PEER_SCORE_PENALTY || '0.7');

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','and','or','for','with','by','is','are','be',
  'it','as','at','from','that','this','these','those','we','our','you','your','i','my'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Build corpus: one "document" per agent.
function buildCorpus(agents) {
  return agents.map(a => {
    const m = a.manifest || {};
    const doc = [...(m.capabilities || []), ...(m.models || []), a.agent].join(' ');
    return { agent: a.agent, tokens: tokenize(doc) };
  });
}

function tfidf(query, corpus) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || corpus.length === 0) return [];

  // Document frequency
  const df = new Map();
  for (const doc of corpus) {
    const unique = new Set(doc.tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = corpus.length;

  const scored = corpus.map(doc => {
    // Term frequency within the agent doc
    const tf = new Map();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qTokens) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + N / (df.get(q) || 1));
      score += f * idf;
    }
    return { agent: doc.agent, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Top-N agents for a brief, optionally filtered by required capabilities.
// includeFederated pulls cached peer capabilities too, with a score penalty
// so local agents always win ties.
function match(brief, { required = [], topN = 3, includeFederated = false } = {}) {
  let agents = store.list();
  if (required.length > 0) {
    agents = agents.filter(a => {
      const caps = new Set((a.manifest.capabilities || []).map(c => c.toLowerCase()));
      return required.every(r => caps.has(r.toLowerCase()));
    });
  }
  const corpus = buildCorpus(agents);
  const localScored = tfidf(brief, corpus).map(s => ({ ...s, source: 'local' }));

  let combined = localScored;
  if (includeFederated) {
    let peerAgents = [];
    try {
      const peers = require('../federation/peers');
      peerAgents = peers.allRemoteCapabilities();
    } catch { peerAgents = []; }

    if (peerAgents.length > 0) {
      // Adapt remote capability shape to corpus shape.
      const adapted = peerAgents.map(r => ({
        agent: r.agent, manifest: { capabilities: r.capabilities, models: r.models },
        peerId: r.peerId
      }));
      if (required.length > 0) {
        const filtered = adapted.filter(a => {
          const caps = new Set((a.manifest.capabilities || []).map(c => c.toLowerCase()));
          return required.every(r => caps.has(r.toLowerCase()));
        });
        peerAgents = filtered;
      }
      const peerCorpus = buildCorpus(peerAgents.map(r => ({
        agent: r.agent, manifest: r.manifest || { capabilities: r.capabilities }
      })));
      const peerScored = tfidf(brief, peerCorpus).map(s => {
        const pa = peerAgents.find(a => a.agent === s.agent);
        return {
          agent: s.agent,
          score: s.score * PEER_PENALTY,
          source: 'peer:' + (pa && pa.peerId),
          peerId: pa && pa.peerId
        };
      });
      combined = [...localScored, ...peerScored].sort((a, b) => b.score - a.score);
    }
  }

  return combined.slice(0, topN);
}

module.exports = { match, tokenize, tfidf, buildCorpus };
