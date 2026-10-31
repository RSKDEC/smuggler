// Runs on the Chromecast. Phones (senders) tell it which room to show over a
// custom message channel; it answers with the room code so they can join.
(() => {
  const NS = 'urn:x-cast:com.smuggler.game';
  const onChromecast = typeof cast !== 'undefined' && cast.framework && /CrKey/.test(navigator.userAgent);

  // Opened in a normal browser (e.g. for testing): behave like /host.
  if (!onChromecast) {
    window.smugglerShow(new URLSearchParams(location.search).get('room'));
    return;
  }

  const ctx = cast.framework.CastReceiverContext.getInstance();
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = { [NS]: cast.framework.system.MessageType.JSON };
  // A party game has no media playing; keep the app open between rounds.
  options.disableIdleTimeout = true;
  options.maxInactivity = 3600;

  // Tell every connected phone which room is on screen.
  let current = null;
  window.onSmugglerRoom = (code) => {
    current = code;
    try {
      ctx.sendCustomMessage(NS, undefined, { type: 'room', code });
    } catch (e) {
      console.warn('Could not message senders', e);
    }
  };

  ctx.addCustomMessageListener(NS, (event) => {
    const msg = event.data || {};
    if (msg.type === 'show') window.smugglerShow(msg.code || null);
    else if (msg.type === 'hello' && current) window.onSmugglerRoom(current);
  });

  ctx.start(options);
})();
