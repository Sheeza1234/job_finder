// A server holding a CV and personal data must not be reachable from the network without a password.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
function assertSafeBind(host, password, allowInsecure = false) {
  if (LOOPBACK.includes(host) || password || allowInsecure) return;
  throw new Error(`Refusing to listen on ${host} without APP_PASSWORD: your CV and personal data would be reachable without a login. Set APP_PASSWORD, bind to 127.0.0.1, or set ALLOW_INSECURE=true if a trusted proxy already enforces authentication.`);
}
module.exports = { assertSafeBind, LOOPBACK };
