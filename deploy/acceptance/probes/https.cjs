// Outbound HTTPS test. Arg: <url>. Prints status=<code> or error=<code>; exit 0 on any HTTP status.
fetch(process.argv[1], { method: 'HEAD', signal: AbortSignal.timeout(10000) })
  .then((r) => { console.log(`status=${r.status}`); process.exit(0); })
  .catch((e) => { console.log(`error=${(e.cause && e.cause.code) || e.name}`); process.exit(1); });
