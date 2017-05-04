'use strict';

/**
 * BEGIN CUSTOM U2F-API.JS
 */
/**
 * Namespace for the U2F api.
 * @type {Object}
 */
var u2f = u2f || {};

/**
 * The U2F extension id
 * @const {string}
 */
// The Chrome packaged app extension ID.
// Uncomment this if you want to deploy a server instance that uses
// the package Chrome app and does not require installing the U2F Chrome extension.
// u2f.EXTENSION_ID = 'kmendfapggjehodndflmmgagdbamhnfd';
// The U2F Chrome extension ID.
// Uncomment this if you want to deploy a server instance that uses
// the U2F Chrome extension to authenticate.
u2f.EXTENSION_ID = 'pfboblefjcgdjicmnffhdgionmgcdmne';

/**
 * Response status codes
 * @const
 * @enum {number}
 */
u2f.ErrorCodes = {
    'OK': 0,
    'OTHER_ERROR': 1,
    'BAD_REQUEST': 2,
    'CONFIGURATION_UNSUPPORTED': 3,
    'DEVICE_INELIGIBLE': 4,
    'TIMEOUT': 5
};

/**
 * Message types for messsages to/from the extension
 * @const
 * @enum {string}
 */
u2f.MessageTypes = {
    'U2F_REGISTER_REQUEST': 'u2f_register_request',
    'U2F_REGISTER_RESPONSE': 'u2f_register_response',
    'U2F_SIGN_REQUEST': 'u2f_sign_request',
    'U2F_SIGN_RESPONSE': 'u2f_sign_response',
    'U2F_GET_API_VERSION_REQUEST': 'u2f_get_api_version_request',
    'U2F_GET_API_VERSION_RESPONSE': 'u2f_get_api_version_response'
};

/**
 * An error object for responses
 * @typedef {{
 *   errorCode: u2f.ErrorCodes,
 *   errorMessage: ?string
 * }}
 */
u2f.Error;


//Low level MessagePort API support

/**
 * Sets up a MessagePort to the U2F extension using the
 * available mechanisms.
 * @param {function((MessagePort|u2f.WrappedChromeRuntimePort_))} callback
 */
u2f.getMessagePort = function(callback) {
  if (typeof chrome != 'undefined' && chrome.runtime) {
    // The actual message here does not matter, but we need to get a reply
    // for the callback to run. Thus, send an empty signature request
    // in order to get a failure response.
    var msg = {
        type: 'u2f_sign_request',
        signRequests: []
    };
    chrome.runtime.sendMessage(u2f.EXTENSION_ID, msg, function() {
      if (!chrome.runtime.lastError) {
        // We are on a whitelisted origin and can talk directly
        // with the extension.
        u2f.getChromeRuntimePort_(callback);
      } else {
        // chrome.runtime was available, but we couldn't message
        // the extension directly, use iframe
        u2f.getIframePort_(callback);
      }
    });
  } else {
    // chrome.runtime was not available at all, which is normal
    // when this origin doesn't have access to any extensions.
    u2f.getIframePort_(callback);
  }
};

/**
 * Connects directly to the extension via chrome.runtime.connect.
 * @param {function(u2f.WrappedChromeRuntimePort_)} callback
 * @private
 */
u2f.getChromeRuntimePort_ = function(callback) {
  var port = chrome.runtime.connect(u2f.EXTENSION_ID,
      {'includeTlsChannelId': true});
  setTimeout(function() {
    callback(new u2f.WrappedChromeRuntimePort_(port));
  }, 0);
};

/**
 * A wrapper for chrome.runtime.Port that is compatible with MessagePort.
 * @param {Port} port
 * @constructor
 * @private
 */
u2f.WrappedChromeRuntimePort_ = function(port) {
  this.port_ = port;
};

/**
 * Posts a message on the underlying channel.
 * @param {Object} message
 */
u2f.WrappedChromeRuntimePort_.prototype.postMessage = function(message) {
  this.port_.postMessage(message);
};


/**
 * Emulates the HTML 5 addEventListener interface. Works only for the
 * onmessage event, which is hooked up to the chrome.runtime.Port.onMessage.
 * @param {string} eventName
 * @param {function({data: Object})} handler
 */
u2f.WrappedChromeRuntimePort_.prototype.addEventListener =
    function(eventName, handler) {
  var name = eventName.toLowerCase();
  if (name == 'message' || name == 'onmessage') {
    this.port_.onMessage.addListener(function(message) {
      // Emulate a minimal MessageEvent object
      handler({'data': message});
    });
  } else {
    console.error('WrappedChromeRuntimePort only supports onMessage');
  }
};

/**
 * Sets up an embedded trampoline iframe, sourced from the extension.
 * @param {function(MessagePort)} callback
 * @private
 */
u2f.getIframePort_ = function(callback) {
  // Create the iframe
  // var iframeOrigin = 'chrome-extension://' + u2f.EXTENSION_ID;
  var iframeOrigin = 'chrome-extension://mjkmkmgddddefphbliabfdnlbpbkafpe';

  var iframe = document.createElement('iframe');
  iframe.src = iframeOrigin + '/u2f-comms.html';
  iframe.setAttribute('style', 'display:none');
  document.body.appendChild(iframe);

  var channel = new MessageChannel();
  var ready = function(message) {
    console.info("MESSAGE:", message);
    if (message.data == 'ready') {
      channel.port1.removeEventListener('message', ready);
      callback(channel.port1);
    } else {
      console.error('First event on iframe port was not "ready"');
    }
  };
  channel.port1.addEventListener('message', ready);
  channel.port1.start();

  iframe.addEventListener('load', function() {
    // Deliver the port to the iframe and initialize
    iframe.contentWindow.postMessage('init', '*', [channel.port2]);
  });
};


//High-level JS API

/**
 * A singleton instance for a MessagePort to the extension.
 * @type {MessagePort|u2f.WrappedChromeRuntimePort_}
 * @private
 */
u2f.port_ = null;

/**
 * Callbacks waiting for a port
 * @type {Array<function((MessagePort|u2f.WrappedChromeRuntimePort_))>}
 * @private
 */
u2f.waitingForPort_ = [];

/**
 * A counter for requestIds.
 * @type {number}
 * @private
 */
u2f.reqCounter_ = 0;

/**
 * A map from requestIds to client callbacks
 * @type {Object.<number,(function((u2f.Error|u2f.RegisterResponse))
 *                       |function((u2f.Error|u2f.SignResponse)))>}
 * @private
 */
u2f.callbackMap_ = {};

/**
 * Creates or retrieves the MessagePort singleton to use.
 * @param {function((MessagePort|u2f.WrappedChromeRuntimePort_))} callback
 * @private
 */
u2f.getPortSingleton_ = function(callback) {
  if (u2f.port_) {
    callback(u2f.port_);
  } else {
    if (u2f.waitingForPort_.length == 0) {
      u2f.getMessagePort(function(port) {
        u2f.port_ = port;
        u2f.port_.addEventListener('message',
            /** @type {function(Event)} */ (u2f.responseHandler_));

        // Careful, here be async callbacks. Maybe.
        while (u2f.waitingForPort_.length)
          u2f.waitingForPort_.shift()(u2f.port_);
      });
    }
    u2f.waitingForPort_.push(callback);
  }
};

/**
 * Handles response messages from the extension.
 * @param {MessageEvent.<u2f.Response>} message
 * @private
 */
u2f.responseHandler_ = function(message) {
	console.info('RESPONSEHANDLER message:', message);
  var response = message.data;
  var reqId = response['requestId'];
  if (!reqId || !u2f.callbackMap_[reqId]) {
    console.error('Unknown or missing requestId in response.');
    return;
  }
  var cb = u2f.callbackMap_[reqId];
  delete u2f.callbackMap_[reqId];
  cb(response['responseData']);
};

function okSetTime() {
 u2f.getPortSingleton_(function(port) {
    var reqId = ++u2f.reqCounter_;
    u2f.callbackMap_[reqId] = function (msg) {
      console.info('OKSETTIME MSG:', msg);
    };

    // var req = {
    //   type: 'OKSETTIME',
    //   timeoutSeconds: 1,
    //   requestId: reqId
    // };

  var req = {
    type: u2f.MessageTypes.U2F_SIGN_REQUEST,
    appId: "*",
    challenge: "dyxhLOosoCzkLEMs4iyBLBUspCy9LEwsOCx",
    registeredKeys: [{
      appId: "*",
      challenge: "dyxhLOosoCzkLEMs4iyBLBUspCy9LEwsOCx",
      clientData: "eyJ0eXAiOiJuYXZpZ2F0b3IuaWQuZmluaXNoRW5yb2xsbWVudCIsImNoYWxsZW5nZSI6ImR5eGhMT29zb0N6a0xFTXM0aXlCTEJVc3BDeTlMRXdzT0N4LUxFY3NoeXlCTEs4c2ppd2tMTUVzZkN5VkxLa3NGQ3daTEVVc2Rpd2VMQndzSUN4RyIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwcy5jcnAudG8iLCJjaWRfcHVia2V5IjoidW51c2VkIn0",
      registrationData: "BQTJCqyjM_YiphcaDeAFclLQx0HdxhH3HTtEWG5wKjOSy",
      version: "U2F_V2"
    }],
    timeoutSeconds: 10,
    requestId: reqId
  };

    port.postMessage(req);
  });
}
