var WebSocket = require('ws');
var EventEmitter = require('events').EventEmitter;
var exit = require('./lib/exit');
var jwt = require('jsonwebtoken');
var nconf = require('nconf');
var fs = require('fs');
var Users = require('./lib/users');
var users = new Users();
var async = require('async');
var cb = require('cb');
var ms = require('ms');

var cert = {
  key: nconf.get('AUTH_CERT_KEY') || fs.readFileSync(__dirname + '/certs/cert.key'),
  cert: nconf.get('AUTH_CERT') || fs.readFileSync(__dirname + '/certs/cert.pem')
};

var authenticate_when_password_expired = nconf.get('ALLOW_PASSWORD_EXPIRED');
var authenticate_when_password_change_required = nconf.get('ALLOW_PASSWORD_CHANGE_REQUIRED');

var socket_server_address = nconf.get('AD_HUB').replace(/^http/i, 'ws');

var AccountDisabled = require('./lib/errors/AccountDisabled');
var AccountExpired = require('./lib/errors/AccountExpired');
var AccountLocked = require('./lib/errors/AccountLocked');
var PasswordChangeRequired = require('./lib/errors/PasswordChangeRequired');
var PasswordExpired = require('./lib/errors/PasswordExpired');
var WrongPassword = require('./lib/errors/WrongPassword');
var WrongUsername = require('./lib/errors/WrongUsername');
var InsufficientAccessRightsError = require('./lib/errors/InsufficientAccessRightsError');
var PasswordComplexityError = require('./lib/errors/PasswordComplexityError');
var ws;

var emitter = new EventEmitter();
emitter.close = () => ws && ws.close();

// reconnection interval
const reconnectionInterval = nconf.get('WS_RECONNECT_INTERVAL_MS') || 10000;

// used by timer, determine if socket has to be rebuilt or not
let openedSocket = false;

function setupWebsocket() {
  ws = new WebSocket(socket_server_address);

  return new Promise((resolve, reject) => {   
    ws.sendEvent = function (name, payload) {
      this.send(JSON.stringify({
        n: name,
        p: payload
      }));
    };

    ws.reply = function (pid, response) {
      return this.sendEvent(pid + '_result', response);
    };

    function ping(client, count, callback) {
      if (typeof count === 'undefined') {
        count = 0;
        callback = function () {};
      }

      var pong = cb(function (err) {
        if (err instanceof cb.TimeoutError &&
            client.listeners('pong').length > 0) {
          client.removeListener('pong', pong);
          if (count === 4) {
            return callback(new Error(
              `Auth0 server didn't respond to ${(count + 1)} ping commands. Re-pinging.`
            ));
          }
          return ping(client, ++count, callback);
        }
        callback(null, { failed_pings: count });
      }).timeout(ms('4s'));

      if (client.readyState !== WebSocket.OPEN) {
        return callback(null, { failed_pings: 0 });
      }

      client.once('pong', pong).ping('');
    }

    var log_from_auth0 = console.log.bind(console, 'auth0'.blue + ':');

    console.log('Connecting to ' + socket_server_address.green + '.');

    ws.on('open', function () {
      authenticate_connector();
      openedSocket = true;
      resolve(openedSocket);
    }).on('message', function (msg) {
      var m;
      try {
        m = JSON.parse(msg);
      } catch (er) {
        return;
      }
      if (!m || !m.n) return;
      this.emit(m.n, m.p);
    }).on('error', function (err) {
      console.error('Socket error: ' + err);
      openedSocket = false;
      reject(err);
    }).on('authenticated', function () {
      log_from_auth0('Agent accepted.');
      var client = this;

      async.whilst(
        function () {
          return client.readyState === WebSocket.OPEN;
        },
        function (done) {
          setTimeout(function () {
            ping(client, 0, function (err, result) {
              if (err) return done(err);
              if (result.failed_pings > 0) {
                console.log('Ping success after failed ' + result.failed_pings + ' pings.');
              }
              done();
            });
          }, ms('5s'));
        },
        function (err) {
          if (err) {
            console.log(err.message);
            openedSocket = false;
          }
        }
      );

    }).on('authentication_failure', function () {
      log_from_auth0('Agent ' + 'rejected'.red + '.');
      exit(0);
    }).on('close', function () {
      if (process.exiting) {
        log_from_auth0('Connection closed as requested.');
        emitter.emit('close');
      } else {
        log_from_auth0('Connection closed, reconnecting.');
        openedSocket = false;
      }
    }).on('authenticate_user', function (msg) {
      jwt.verify(msg.jwt, nconf.get('TENANT_SIGNING_KEY'), function (err, payload) {
        if (err) {
          console.error('Unauthorized attemp of authentication.');
          return;
        }

        var log_prepend = 'user ' + payload.username + ':';

        var log = console.log.bind(console, log_prepend.blue);

        log('Starting authentication attempt.');

        users.validate(payload.username, payload.password, function (err, user) {
          if (err) {
            if (err instanceof AccountDisabled) {
              log("Authentication attempt failed. Reason: " + "account disabled".red);
              return ws.reply(payload.pid, {
                err: err,
                profile: err.profile
              });
            }
            if (err instanceof AccountExpired) {
              log("Authentication attempt failed. Reason: " + "account expired".red);
              return ws.reply(payload.pid, {
                err: err,
                profile: err.profile
              });
            }
            if (err instanceof AccountLocked) {
              log("Authentication attempt failed. Reason: " + "account locked".red);
              return ws.reply(payload.pid, {
                err: err,
                profile: err.profile
              });
            }
            if (err instanceof PasswordChangeRequired) {
              if (authenticate_when_password_change_required) {
                log("Authentication succeeded, but " + "password change is required".red);
                return ws.sendEvent(payload.pid + '_result', {
                  profile: err.profile
                });
              } else {
                log("Authentication attempt failed. Reason: " + "password change is required".red);
                return ws.reply(payload.pid, {
                  err: err,
                  profile: err.profile
                });
              }
            }
            if (err instanceof PasswordExpired) {
              if (authenticate_when_password_expired) {
                log("Authentication succeeded but " + "password expired".red);
                return ws.sendEvent(payload.pid + '_result', {
                  profile: err.profile
                });
              } else {
                log("Authentication attempt failed. Reason: " + "password expired".red);
                return ws.reply(payload.pid, {
                  err: err,
                  profile: err.profile
                });
              }
            }
            if (err instanceof WrongPassword) {
              log("Authentication attempt failed. Reason: " + "wrong password".red);
              return ws.reply(payload.pid, {
                err: err,
                profile: err.profile
              });
            }
            if (err instanceof WrongUsername) {
              log("Authentication attempt failed. Reason: " + "wrong username".red);
              return ws.reply(payload.pid, {
                err: err,
                profile: {
                  username: payload.username
                }
              });
            }
            log("Authentication attempt failed. Reason: " + "unexpected error".red);

            if (err.inner && err.inner.stack) {
              console.error('Inner error:', err.inner.stack);
            } else {
              console.log(err);
            }

            ws.reply(payload.pid, {
              err: err
            });
            return exit(1);
          }

          log('Authentication succeeded.');

          ws.sendEvent(payload.pid + '_result', {
            profile: user
          });
        });
      });
    }).on('search_users', function (msg) {
      jwt.verify(msg.jwt, nconf.get('TENANT_SIGNING_KEY'), function (err, payload) {
        if (err) {
          console.error('Unauthorized attemp of search_users.');
          return;
        }

        console.log('Searching users.');

        var options = {
          limit: payload.limit
        };

        users.list(payload.search, options, function (err, users) {
          if (err) return ws.sendEvent(payload.pid + '_search_users_result', {
            err: err
          });
          console.log('Search succeeded.');
          ws.sendEvent(payload.pid + '_search_users_result', {
            users: users
          });
        });
      });
    }).on('list_groups', function(msg) {
      jwt.verify(msg.jwt, nconf.get('TENANT_SIGNING_KEY'), function(err, payload) {
        if (err) {
          console.error('Unauthorized attempt of list_groups');
          return;
        }

        console.log('Listing groups.');

        var options = {
          limit: payload.limit
        };

        users.listGroups(options, function (err, groups) {
          if (err) return ws.sendEvent(payload.pid + '_list_groups_result', {
            err: err
          });
          console.log('Listing groups succeeded.');
          ws.sendEvent(payload.pid + '_list_groups_result', {
            groups: groups
          });
        });
      })
    });

    // Listen only for change_password event when write back is enabled.
    if (nconf.get('ENABLE_WRITE_BACK')) {
      ws.on('change_password', function (command) {
        jwt.verify(command.jwt, nconf.get('TENANT_SIGNING_KEY'), function (err, payload) {
          if (err) {
            console.error('Unauthorized change_password attempt');
            return;
          };

          var log_prepend = 'user ' + payload.username + ':';
          var log = console.log.bind(console, log_prepend.blue);

          log('Attempting change_password.');

          users.changePassword(payload.username, payload.password, function (err, profile) {
            if (err) {
              if (err instanceof InsufficientAccessRightsError || err instanceof PasswordComplexityError) {
                log("Change Password attempt failed. Reason: " + err.message.red);
                return ws.sendEvent(payload.pid + '_change_password_result', {
                  err: err,
                  profile: err.profile
                });
              }

              log("Change Password attempt failed. Reason: " + "unexpected error".red);

              if (err.inner && err.inner.stack) {
                console.error('Inner error:', err.inner.stack);
              } else {
                console.log(err);
              };

              ws.sendEvent(payload.pid + '_change_password_result', {
                err: err
              });
              return exit(1);
            }

            log('Password Change succeeded.');
            ws.sendEvent(payload.pid + '_change_password_result', {
              profile: profile
            });
          });
        });
      });
    }

    function authenticate_connector() {
      var token = jwt.sign({}, cert.key, {
        algorithm: 'RS256',
        expiresIn: '1m',
        issuer: nconf.get('CONNECTION'),
        audience: nconf.get('REALM')
      });

      ws.sendEvent('authenticate', {
        jwt: token
      });
    };
  })
}

async function reconnect() {
  try {
    console.log('Connecting to websocket...');
    await setupWebsocket();
    console.log('Connected to websocket');
  } catch (err) {
    console.error('websocket connection error:', new Error(err).message)
  }
}

reconnect();

// check periodically if reconnection is needed
setInterval(() => {
  if (!openedSocket) {
    console.log('websocket deconnected. reconnecting')
    if(ws) {
      ws.removeAllListeners();
      ws.terminate();
      ws = null;
    }
    reconnect()
  }
}, reconnectionInterval)

module.exports = emitter;
