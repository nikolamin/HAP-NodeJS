var Accessory = require('./').Accessory;
var Service = require('./').Service;
var Characteristic = require('./').Characteristic;
var uuid = require('./').uuid;

let removeKey = function(k) { let t = this[k]; delete this[k]; return t; }

String.prototype.capitalize = function() {
	return this.charAt(0).toUpperCase() + this.slice(1);
}
Accessory.prototype.isPublished = function() {
    return this._server != undefined;
}

function getOrUpdate(storage, key, defVal) {
    var data = storage.getItemSync(key);
    if(!data) {
        storage.setItemSync(key, data = defVal)
    }
    return data;
}
function getPort(storage, uuid, callback) {
    var config = storage.getItem(uuid) || {};
    if(config && config.port) {
        return callback(config.port);
    }
    let nextPort = getOrUpdate(storage, "next_port", 51826);
    let portScanner = new ListenPortScanner(nextPort, 52826);
    portScanner.findNext(function(isSuccess, port) {
        if(isSuccess) {
            config.port = port;
            storage.setItemSync("next_port", port + 1);
            storage.setItemSync(uuid, config);
            callback(port);
        } else {
            callback();
        }
    });    
}

class ESPAccessory {
    constructor(storage, name, pin, displayName, category, version) {
        this.storage = storage;
        this.name = name;
        this.pin = pin;
        this.displayName = displayName;
        this.category = category || Accessory.Categories.OTHER;
        this.deviceUUID = uuid.generate('hap-nodejs:accessories:' + name);
        this.deviceVersion = version;
        this.bridgeVersion = 1;
        var device = new Accessory(displayName || 'Accessory', this.deviceUUID);
        device.username = name;
        device.pincode = pin || "000-00-001";
        device.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, "DIY")
            .setCharacteristic(Characteristic.Model, "Rev-1")
            .setCharacteristic(Characteristic.SerialNumber, "TW000165")
            .setCharacteristic(Characteristic.FirmwareRevision, this.bridgeVersion)
            .setCharacteristic(Characteristic.HardwareRevision, this.deviceVersion);
        device.on('identify', function (paired, callback) { console.log("identify"); callback(); });
        this.device = device;
        this._messages = [];
        this._services = {};
        console.log("ESPAccessory", name, pin);
    }
    init(connection) {
        console.log("init");
        this._clearConnection();
        if(this.tmUnpublish) { clearTimeout(this.tmUnpublish); }
        connection.on('message', this._onMessage.bind(this));
        connection.on('close', this._onConnectionClose.bind(this, connection));
        this._connection = connection;
    }
    _onConnectionClose(connection, reason, status) {
        console.error(`Connection Close (${this.name} ${this.displayName})`, reason, status);
        this._clearConnection(connection);
        this._messages = [];
        if (this.device != undefined && this.device.isPublished()) {
            if(this.expire && typeof(this.expire) == "number") {
                if(this.tmUnpublish) { clearTimeout(this.tmUnpublish); }
                this.tmUnpublish = setTimeout(function() {
                    this.tmUnpublish = undefined;
                    this.device.unpublish();
                    console.log("Unpublish", this._server == undefined);
                }.bind(this), this.expire);
                console.log("To Unpublish in ", this.expire);
            } else {
                this.device.unpublish();
                console.log("Unpublish", this._server == undefined);
            }
            // for (var index in this.device.services) {
            //     this.device.services[index].getCharacteristic(Characteristic.Active).updateValue(0);    
            // }
        }
    }
    _onMessage(message) {
        console.log("Message", message);
        if (message && message.type !== 'utf8')
            return;
        var msgObj = JSON.parse(message.utf8Data);
        if (msgObj == undefined) {
            console.error("Wrong message format (not json)", msgObj.length);
            return;
        }
        if(Array.isArray(msgObj)) {
            for(var i in msgObj) {
                this._handleMessage(msgObj[i]);
            }
        } else {
            this._handleMessage(msgObj);
        }
    }
    _handleMessage(msg) {
        if (msg == undefined || (msg.payload == undefined && msg.ack != true)) {
            console.error("Wrong message format no ack or payload", msgObj.length);
            return false;
        }
        if(typeof msg._msg != "number") {
            console.error("Invalid message id", msg._msg);
            return false;
        }
        var msgId = msg._msg;
        if (msg.ack) {
            var handler = this._messages[msgId];
            if (typeof handler == "function")
                handler();
            this._messages[msgId] = undefined;
            return false;
        } else if(msg.payload) {
            var payload = msg.payload;
            if("publish" == payload.cmd) {
                this.expire = payload.expire;
                if (this.device.isPublished()) {
                    this._connection.sendACK(msg, false, "Already published!");
                    return;
                }
                getPort(this.storage, this.deviceUUID, function(port) {
                    console.log("Publishing on:", port);
                    this.device.publish({
                        port: port,
                        username: this.name,
                        pincode: this.pin,
                        category: this.category
                    });
                    this._connection.sendACK(msg);
                }.bind(this));
            } else if("register" == payload.cmd) {
                let info = payload.service;
                let serviceName = removeKey.bind(info)("service");
                if(serviceName == undefined) { console.error("Undefined service name."); return; }
                let serviceRef = Service[serviceName.capitalize()];
                if(serviceRef == undefined) { console.error(`Unsupported service '${serviceName}'.`); return; }
                
                let serviceId = removeKey.bind(info)("id");
                this._addService(serviceRef, serviceName, serviceId, function(service) {
                    for(var k in info) {
                        if(!info.hasOwnProperty(k)) continue;
                        let conf = info[k];
                        if(typeof conf != "object") continue;
                        if(Characteristic[k] == undefined) { console.error(`Unsuported characteristic ${k}`); return; }
                        let characteristic = service.getCharacteristic(Characteristic[k], true);
                        if(!conf.eventsOnly) {
                            characteristic.on('set', this.accessorySetHandler(serviceName, serviceId, k));                            
                        }
                        if(conf.props !== undefined) {
                            characteristic.setProps(conf.props)
                        }
                        if(conf.value == undefined) {
                            conf.value = false;
                        }
                    }
                });

                // this._connection.sendACK(msg);

                for(var k in info) {
                    if(!info.hasOwnProperty(k)) continue;
                    let conf = info[k];
                    if(typeof conf != "object") continue;
                    if(conf.eventsOnly) {
                        this.accessoryValue(serviceName, serviceId, k, conf.value || false);
                    } else {
                        let state = this.accessoryValue(serviceName, serviceId, k);
                        if(state == false || state.value == undefined || state.time == 0 || conf.valueTime >= state.time) {
                            this.accessoryValue(serviceName, serviceId, k, conf.value || false);
                        } else {
                            if(state.value) {
                                let payload = {cmd: 'set', value: state.value, time: state.time, service: serviceName, property: k, id: serviceId};
                                setTimeout(function() {
                                    console.log("Update", payload);
                                    this._connection.sendPayload(payload);
                                }.bind(this),1000);
                            }
                            this.accessoryValue(serviceName, serviceId, k, state.value || false);
                        }
                    }
                }
                
            } else if("set" == payload.cmd) {
                if(payload.property == undefined) { console.error("SET service value without property."); return; }
                var characteristic = Characteristic[payload.property.capitalize()];
                if(characteristic == undefined) { console.error(`SET service value for unsuported '${payload.property}' property.`); return; }
                let result = this.accessoryValue(payload.service, payload.id, payload.property, payload.value);
                this._connection.sendACK(msg, result ? false : "Failed!");
            } else {
                console.warn("Unsuported command: ", payload.cmd);
                return false;
            }
        } else {
            console.log("Invalid message:", msg);
            return false;
        }
        return true;
    }
    _clearConnection(connection) {
        if (this._connection != undefined && (connection == undefined || connection == this._connection)) {
            console.log("clear and close");
            this._connection.removeAllListeners();
            this._connection.close();
            this._connection = undefined;
        }
    }
    accessorySetHandler(service, id, property) {
        return function(value, callback) {
            console.log("SET State", service, id, property, value);
            if(this._connection != undefined) {
                var msgId = this._connection.sendPayload({cmd: 'set', value: value, time: now(), service: service, id: id, property: property});
                this._messages[msgId] = callback;
                return;
            }
            console.log("Device is offline");
            this.accessoryValue(service, id, property, value);
            callback(new Error("Device is offline"));
        }.bind(this);
    }
    _addService(category, strCategory, id, callback) {
        var name = `${strCategory.match(/[A-Z]?[a-z\d]+/)[0]} #${id}`;
        var service = this.device.getService(name);
        if(service == undefined) {
            service = this.device.addService(category, name, id);
            service.getCharacteristic(Characteristic.Name)
            .on('get', function(callback) {
                console.log("Device name", name);
              callback(null, name);
            });
            if(callback) callback.bind(this)(service);
        }
        strCategory = strCategory.toLowerCase();
        var services = this._services[strCategory];
        if(services)
            services[id] = service;
        else
            this._services[strCategory] = { [id]: service }
        
        return service;
    }
    _getService(serviceName, id) {
        var services = this._services[serviceName.toLowerCase()];
        if(services) {
            return services[id];
        }
        return undefined;
    }
    accessoryValue(serviceName, id, property, value = null) {
        let service = this._getService(serviceName, id);
        if(service == undefined) {
            console.error("Service not found", serviceName);
            return false;
        }
        let characteristic = service.getCharacteristic(Characteristic[property.capitalize()]);
        if(characteristic == undefined) {
            console.error(`Characteristic not found for service '${serviceName}'!`, property);
            return false;
        }
        if(value != null) {
            return characteristic.updateValue(value);
        }
        return { service: service, property: characteristic, value: characteristic.value, time: characteristic.valueTime }
    }
}





module.exports = ESPAccessory