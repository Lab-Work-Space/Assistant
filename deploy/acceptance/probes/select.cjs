// App-level backend choice with the real container check (spec 4.4): socket when MEDIA_SOCKET is set; in a container without it,
// no backend ("media sidecar not configured", music and voice off). Prints one JSON line.
Promise.all([import('/app/dist/media/select.js'), import('/app/dist/providers/claude-code-local/guard.js')]).then(([sel, guard]) => {
  const r = sel.selectMediaBackend({
    ...(process.env.MEDIA_SOCKET ? { mediaSocket: process.env.MEDIA_SOCKET } : {}),
    inContainer: () => guard.inContainer(guard.nodeGuardFs),
    local: () => ({ kind: 'local' }),
    socket: (p) => ({ kind: 'socket', p }),
  });
  console.log(JSON.stringify({ inContainer: guard.inContainer(guard.nodeGuardFs), result: r }));
}).catch((e) => { console.log(`error=${e.message}`); process.exit(1); });
