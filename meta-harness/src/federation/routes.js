// Federation routes.
//
//   POST   /v1/peers                  admin — add peer (TOFU the root out-of-band)
//   GET    /v1/peers                  public — list peers (no secrets)
//   DELETE /v1/peers/:id              admin — remove peer
//   POST   /v1/peers/:id/refresh      admin — force re-handshake
//   POST   /v1/federation/handshake   signed — peer → us capability exchange
//   GET    /v1/federation/capabilities  public — our public agents (snapshot)

const peers = require('./peers');
const handshake = require('./handshake');
const trust = require('../credentials/trustAnchors');
const tokens = require('../credentials/tokens');
const audit = require('../audit/log');
const events = require('../ws/events');

function publicPeerView(p) {
  return { id: p.id, url: p.url, addedAt: p.addedAt, lastSyncAt: p.lastSyncAt };
}

function register(app) {
  // Admin — add peer and complete initial handshake
  app.route('POST', '/v1/peers', async (req, res, params, body) => {
    if (!body || !body.url || !body.trustRoot) return app.json(res, 400, { error: 'missing_fields', need: ['url', 'trustRoot'] });
    const id = peers.peerIdFor(body.trustRoot);

    // Trust the peer's root BEFORE handshake so we can verify the response token on the way back in.
    trust.addTrustedRoot(body.trustRoot, `peer:${id}`);

    // Outbound handshake: peer verifies our token against OUR root pubkey that they've already pinned.
    let hs;
    try {
      hs = await handshake.outboundHandshake({ peerUrl: body.url, peerTrustRoot: body.trustRoot });
    } catch (e) {
      trust.removeTrustedRoot(trust.kidOf(body.trustRoot));  // roll back trust on failure
      audit.append({ actor: 'operator', action: 'peer_add_failed', detail: { id, url: body.url, reason: e.message } });
      return app.json(res, 502, { error: 'handshake_failed', reason: e.message });
    }

    peers.saveCapabilities(id, hs.capabilities);
    peers.upsert({
      id, url: body.url, trustRoot: body.trustRoot,
      addedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      capabilityCount: hs.capabilities.length
    });

    audit.append({ actor: 'operator', action: 'peer_added', detail: { id, url: body.url, capabilityCount: hs.capabilities.length } });
    events.broadcast('peer_added', { id, url: body.url });
    app.json(res, 200, { peer: publicPeerView(peers.find(id)), capabilityCount: hs.capabilities.length });
  }, { adminToken: true });

  app.route('GET', '/v1/peers', (req, res) => {
    app.json(res, 200, { peers: peers.list().map(publicPeerView) });
  });

  app.route('DELETE', '/v1/peers/:id', async (req, res, params) => {
    const p = peers.find(params.id);
    if (!p) return app.json(res, 404, { error: 'not_found' });
    // removeTrustedRoot refuses to remove source='self', so self-loops are safe.
    trust.removeTrustedRoot(trust.kidOf(p.trustRoot));
    peers.remove(params.id);
    audit.append({ actor: 'operator', action: 'peer_removed', detail: { id: params.id } });
    events.broadcast('peer_removed', { id: params.id });
    app.json(res, 200, { ok: true, id: params.id });
  }, { adminToken: true });

  app.route('POST', '/v1/peers/:id/refresh', async (req, res, params) => {
    const p = peers.find(params.id);
    if (!p) return app.json(res, 404, { error: 'not_found' });
    try {
      const hs = await handshake.outboundHandshake({ peerUrl: p.url, peerTrustRoot: p.trustRoot });
      peers.saveCapabilities(p.id, hs.capabilities);
      peers.upsert({ ...p, lastSyncAt: new Date().toISOString(), capabilityCount: hs.capabilities.length });
      audit.append({ actor: 'operator', action: 'peer_refreshed', detail: { id: p.id, capabilityCount: hs.capabilities.length } });
      events.broadcast('peer_refreshed', { id: p.id });
      app.json(res, 200, { ok: true, capabilityCount: hs.capabilities.length });
    } catch (e) {
      audit.append({ actor: 'operator', action: 'peer_refresh_failed', detail: { id: p.id, reason: e.message } });
      app.json(res, 502, { error: 'refresh_failed', reason: e.message });
    }
  }, { adminToken: true });

  // Inbound handshake — requires a capability token that chains to a trusted root.
  app.route('POST', '/v1/federation/handshake', async (req, res, params, body) => {
    if (!body || !body.capabilityToken || !body.peerTrustRoot || !Array.isArray(body.capabilities)) {
      return app.json(res, 400, { error: 'missing_fields', need: ['capabilityToken', 'peerTrustRoot', 'capabilities'] });
    }

    // The peer's trustRoot must be known to us (operator added them via /v1/peers first).
    const existingKid = trust.kidOf(body.peerTrustRoot);
    if (!trust.lookupTrustedRoot(existingKid)) {
      // Not trusted; reject. Peer must be added via admin first — no automatic trust.
      return app.json(res, 401, { error: 'untrusted_peer_root' });
    }

    const v = tokens.verify(body.capabilityToken);
    if (!v.ok) return app.json(res, 401, { error: 'credential_invalid', reason: v.reason });

    // Accept their capabilities into our cache keyed by peerId
    const peerId = peers.peerIdFor(body.peerTrustRoot);
    peers.saveCapabilities(peerId, body.capabilities);
    peers.upsert({
      id: peerId, url: body.url || null, trustRoot: body.peerTrustRoot,
      lastSyncAt: new Date().toISOString(), capabilityCount: body.capabilities.length,
      addedAt: peers.find(peerId) ? peers.find(peerId).addedAt : new Date().toISOString()
    });
    audit.append({ actor: 'system', action: 'inbound_handshake', detail: { peerId, capabilityCount: body.capabilities.length } });
    events.broadcast('peer_synced', { id: peerId, capabilityCount: body.capabilities.length });

    const response = handshake.inboundHandshake({ peerTrustRoot: body.peerTrustRoot });
    app.json(res, 200, response);
  });

  // Public capability index — anyone can fetch. If you want auth, set
  // MH_REQUIRE_CREDENTIAL=1 + use /v1/federation/handshake instead.
  app.route('GET', '/v1/federation/capabilities', (req, res) => {
    const root = trust.ensureRoot();
    app.json(res, 200, {
      ourTrustRoot: root.publicKey,
      kid: root.kid,
      capabilities: handshake.ourCapabilities(),
      updatedAt: new Date().toISOString()
    });
  });
}

module.exports = { register };
