// Cast sender: lets a phone put the TV screen on a Chromecast. Only works in
// Chrome on Android/desktop (iOS can't cast from a web page); elsewhere the
// Cast button simply never appears.
const castSender = (() => {
  const NS = 'urn:x-cast:com.smuggler.game';
  const appId = window.SMUGGLER_CONFIG && window.SMUGGLER_CONFIG.castAppId;
  let available = false;
  let connected = false;
  let wantCode = null;
  let onChange = () => {};
  let onRoom = () => {};

  const ctx = () => cast.framework.CastContext.getInstance();

  function listen(session) {
    session.addMessageListener(NS, (ns, raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (msg && msg.type === 'room') onRoom(msg.code);
      } catch {}
    });
  }

  if (appId) {
    window.__onGCastApiAvailable = (ok) => {
      if (!ok) return;
      ctx().setOptions({ receiverApplicationId: appId, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      const update = () => {
        const st = ctx().getCastState();
        available = st !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
        connected = st === cast.framework.CastState.CONNECTED;
        onChange();
      };
      ctx().addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, update);
      ctx().addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
        const S = cast.framework.SessionState;
        const session = ctx().getCurrentSession();
        if (!session) return;
        if (e.sessionState === S.SESSION_STARTED) {
          listen(session);
          session.sendMessage(NS, { type: 'show', code: wantCode });
        } else if (e.sessionState === S.SESSION_RESUMED) {
          // Page reloaded mid-cast: don't replace the TV's room, just ask which one it shows.
          listen(session);
          session.sendMessage(NS, wantCode ? { type: 'show', code: wantCode } : { type: 'hello' });
        }
      });
      update();
    };
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    document.head.appendChild(s);
  }

  return {
    get available() { return available; },
    get connected() { return connected; },
    set onChange(fn) { onChange = fn; },
    set onRoom(fn) { onRoom = fn; },
    // Put room `code` on the TV, or a brand-new room when code is null.
    // Opens Chrome's device picker if we aren't casting yet.
    show(code) {
      wantCode = code || null;
      const session = ctx().getCurrentSession();
      if (session) return session.sendMessage(NS, { type: 'show', code: wantCode });
      return ctx().requestSession().catch(() => {});
    },
  };
})();
