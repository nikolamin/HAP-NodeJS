var path = require('path');
var storage = require('node-persist');
var uuid = require('./').uuid;
var Accessory = require('./').Accessory;
var accessoryLoader = require('./lib/AccessoryLoader');
var WebSocketServer = require('websocket').server;
var http = require('http');
var ESPAccessory = require('./ESPAccessory')
console.log("HAP-NodeJS starting...");

STATE_TIMEOUT = 2*60000;

now = function() { return new Date().getTime(); }

// Checks is a tcp port available. 
ListenPortScanner = function(initialPort, maxPort) {
  this.nextPort = initialPort;
  this.maxPort = maxPort;
}
ListenPortScanner.prototype.findNext = function(callback) {
  var net = require('net');
  var tester = net.createServer().once('error', function (err) {
    if(++this.nextPort < this.maxPort) {
      this.findNext(callback);
    } else {
      callback(false);
    }
  }.bind(this)).once('listening', function() {
    tester.once('close', function() { callback(true, this.nextPort) }.bind(this)).close();
  }.bind(this)).listen(this.nextPort);
}

// Initialize our storage system
storage.initSync();

// Our Accessories will each have their own HAP server; we will assign ports sequentially
var targetPort = 51826;
var targetPortMax = 52826;

var devices = {};
var server = http.createServer(function(request, response) {});
server.listen(83, function() { });

wsServer = new WebSocketServer({ httpServer: server, closeTimeout: 3000 });
wsServer.on('request', function(request) {
  var connection = request.accept(null, request.origin);
  connection.on('message', connection.initOnMsg = function(message) {
    console.log("New Message", message)
    if (message.type === 'utf8') {
      var msg = JSON.parse(message.utf8Data)
      if(msg == undefined || msg.payload == undefined) { console.err("Wrong message format"); return; }
      var payload = msg.payload;
      if("init" == payload.cmd) {
        var device = devices[msg.payload.name];
        if(device == undefined) {
          device = new ESPAccessory(storage, payload.name, payload.pin, payload.displayName, payload.category, payload.version);
        }
        connection._msg = 0;
        connection.send = function(data) { connection.sendUTF(JSON.stringify(data)); }
        connection.sendPayload = function(data) { connection.sendUTF(JSON.stringify({_msg: ++connection._msg, payload: data})); return connection._msg; }
        connection.sendACK = function(message, error = false, status) { connection.sendUTF(JSON.stringify({_msg: message._msg, ack: true, error: error, status: status, payload: { cmd: message.payload.cmd }})); return true; }
        device.init(connection);
        devices[payload.name] = device;
        connection.device = device;
        connection.removeListener('message', connection.initOnMsg);
        connection.sendACK(msg);
      } 
    }
  });
});