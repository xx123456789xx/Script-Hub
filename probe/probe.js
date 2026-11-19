// Ring script probe: logs every hit; serves a mock response for the example.com test URL.
var url = (typeof $request !== 'undefined' && $request.url) || '';
console.log('RING_PROBE hit: ' + url);
if (url.indexOf('example.com/probe-test') !== -1) {
  $done({
    response: {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'RING SCRIPT PROBE OK'
    }
  });
} else {
  $done({});
}
