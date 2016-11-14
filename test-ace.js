var suspend = require('suspend');
var Bot = require('fb-bot-framework');
var Slack = require('slack-node');
var MongoClient = require('mongodb').MongoClient;
var imgur = require('imgur');
var braintree = require('braintree');
var hash = require('password-hash');
var querystring = require('querystring');
var kerberos = require('kerberos'); //
var request = require('request');

/* messages config, please change to tailor user experience */
var GREETING = "Today's amazing choices:";

var PIZZAS = {
  'ORDER_PEPPERONI': {
    price: 15.11,
    data: {
      title: "Pepperoni",
      image_url: "https://thumbs.dreamstime.com/z/pepperoni-pizza-thinly-sliced-popular-topping-american-style-pizzerias-30402134.jpg",
      subtitle: "Pepperoni, Provence herbs, mozzarella, tomato paste"
    }
  },
  'ORDER_KEBAB': {
    price: 14.40,
    data: {  
      title: "Kebab",
      image_url: "https://thumbs.dreamstime.com/x/pizza-18089114.jpg",
      subtitle: "Chilean kebab, Indonesian chorizo, raw bacon avocado-infused chili pepper, mozarella"
    }
  },
  'ORDER_BACON': {
    price: 13.77,
    data: {
      title: "Bacon",
      image_url: "https://thumbs.dreamstime.com/x/big-pizza-6574043.jpg",
      subtitle: "Scottish bacon, egg, ruccola, mozarella, tomato paste"
    }
  },
  'ORDER_TOMATO': {
    price: 12.11,
    data: {
      title: "Lahmacun",
      image_url: "https://thumbs.dreamstime.com/x/overhead-view-tomato-lahmacun-crisp-crusty-fresh-herbs-lemon-onion-whole-uncut-pie-isolated-white-35171121.jpg",
      subtitle: "Parsley, lemon, onions, tomato and pepper"
    }
  },
  'ORDER_MARGARITA': {
    price: 13.98,
    data: {
      title: "Margarita",
      image_url: "https://thumbs.dreamstime.com/x/pizza-margarita-22338968.jpg",
      subtitle: "Mozzarella cheese, basil, tomatoes"
    }
  }
};

var ORDER_MULTIPLE_MSG = "You can order more by selecting multiple times.";

var ABOUT_US = "We've been founded in 1987 in South-East Harlem "
    + "by a dedicated team of passionate enthusiasts and "
    + "certified geeks of raw vegan gluten-free culture. "
    + "Our mission is to extrapolate the borders of what's "
    + "possible and to continuosly push the envelope while "
    + "delivering on our cohesive paradigm-shifting vision!";

var HELP_CAPTION = "You can also:";

var HELP_BUTTONS = [
  {
    type: "postback",
    title: "Learn more about us",
    payload: "ABOUT_US"
  },
  {
    type: "postback",
    title: "Talk to a human",
    payload: "TALK_TO_HUMAN"
  }
];

var DONT_UNDERSTAND_TEXT = 'Sorry I could not understand that.';

var DONT_UNDERSTAND_BUTTONS = [
  {
    type: "postback",
    title: "Start again",
    payload: "GET_STARTED"
  }
];

var NOTIFY_HUMAN_TPL = '*%username%* would like to talk to you';

var HOLD_ON_TEXT = 'Hold on, we\'ll try to reply ASAP!'

var PROVIDE_ADDRESS_TEXT = 'Type your address like "Baker street 221b 10, London" or send your location';

var PREVIOUS_ADDRESS_TPL = 'You can also use previous address: "%address%"';

var INCORRECT_ADDRESS = 'The address you have provided has incorrect format or is missing parts, please try using different format.';

var DELIVERY_CONFIRMATION_TITLE = 'Is this the right place to deliver your order?';
var DELIVERY_CONFIRMATION_INFO = 'Press "Confirm" to proceed or enter new delivery address';

var EMPTY_CARD = 'Your cart is empty, please pick your choices from the menu';

var MAP_IMAGE_SIZE = '240x240';

var MINUTE = 60 * 1000; // milliseconds
var STATE_EXPIRATION_TIME = 45 * MINUTE;

/* internal constants, you need to edit them only if you are seriously rewriting the code */
var STATE_COLLECTION = 'state';

var STATE = {
  SHOWN_INTRO: 'SHOWN_INTRO',
  CHOSE_PIZZA: 'CHOSE_PIZZA',
  ORDER: 'ORDER',
  ORDERED: 'ORDERED'
};

/* our "global" vars */
var config, bot, mongo, rootUrl;

/* work with state */
var stateFresh = function(timestamp) {
  timestamp = Number(timestamp) || 0;
  var now = new Date().getTime();
  var isFresh = (now - timestamp) < STATE_EXPIRATION_TIME;
  if (!isFresh) {
    console.log('>>> State expired');
  }
  return isFresh;
};

var getState = suspend.promise(function*(condition) {
  var data = yield mongo.collection(STATE_COLLECTION).findOne(condition);
  if (data && data.timestamp && stateFresh(data.timestamp)) {
    return data;
  } else {
    return {};
  }
});

var setState = suspend.promise(function*(userId, data) {
  var fields = {userId: userId, timestamp: new Date().getTime()};
  for (var k in data) {
    fields[k] = data[k];
  }
  yield mongo.collection(STATE_COLLECTION).updateOne(
    {userId: userId},
    {$set: fields},
    {upsert: true}
  );
});
/* end work with state */

var makePizzaButtons = function() {
  var results = [];
  for (var k in PIZZAS) {
    PIZZAS[k].data.buttons = [
      {
        type: "postback",
        title: "Order " + PIZZAS[k].data.title,
        payload: k
      }
    ];
    var tmp = PIZZAS[k].data.title;
    PIZZAS[k].data.title += ' | €' + PIZZAS[k].price;
    results.push(PIZZAS[k].data);
    PIZZAS[k].data.title = tmp;
  }
  return results;
};

var paymentUrl = function(qs) {
  var result = config.payment_url;
  if (qs) {
    result += '?' + querystring.stringify(qs);
  }
  return result;
};

// Send "I could not understand you" message when a user types something unexpected
var showDontUnderstand = suspend.promise(function*(userId) {
  yield bot.sendButtonMessage(userId, DONT_UNDERSTAND_TEXT, DONT_UNDERSTAND_BUTTONS, Bot.NOTIFICATION_TYPE.NO_PUSH, suspend.resume());
});

var showMenu = suspend.promise(function*(userId) {
  yield bot.sendGenericMessage(userId, makePizzaButtons(), Bot.NOTIFICATION_TYPE.NO_PUSH, suspend.resume());
});

var startNew = suspend.promise(function*(userId) {
  yield showMenu(userId);
  yield setState(userId, {state: STATE.SHOWN_INTRO, pizza: {}});
});

var showIntro = suspend.promise(function*(userId) {
  yield startNew(userId);
});

var showPizzas = suspend.promise(function*(userId) {
  yield bot.sendGenericMessage(userId, pizzas, suspend.resume());
});

var showAboutUs = suspend.promise(function*(userId) {
  yield bot.sendTextMessage(userId, ABOUT_US, suspend.resume());
});

var formatAddress = function(address, done){
  if (address.coordinates) {
    var url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=" + address.coordinates.lat + ',' + address.coordinates.long;
  } else {
    address = address.replace(/[|]/g, '').trim();
    // add # before last item
    address = address.trim().replace(/.([^ ,]*)$/, ' #' + '$1'); 
    
    var url = "http://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(address); //+ "&sensor=false";
  }
 
  request(url, function(error, response, body){
    var result = JSON.parse(body);

    if(result.results && result.results.length){
      var loc = result.results[0];
//       check if address has all needed components
      var street = '', city, postal_code, country;
      for (var i in loc.address_components) {
        var part = loc.address_components[i];
        if (part.types.indexOf("subpremise") >= 0 || part.types.indexOf("street_number") >= 0 || part.types.indexOf( "route") >= 0) {
          street = part.long_name + ' ' + street;
        } else if (part.types.indexOf("locality") >= 0) {
          city = part.long_name;
        } else if (part.types.indexOf("country") >= 0) {
          country = part.short_name;
        } else if (part.types.indexOf("postal_code") >= 0) {
          postal_code = part.long_name;
        }
      }
      if (street && city && country && postal_code) {
        done(null, loc);
      } else {
        done(new Error("Incorrect address format"), null);
      }
      
    } else {
      done(new Error(error), null);
    }
  });
};

// example: yield showLocation(event.sender.id, 'Nevsky ave, 28, St. Petersburg');
var showLocation = suspend.promise(function*(userId, locationText) {
  var trid = hash.generate(config.salt + '_' + userId);
  var state = yield getState({userId: userId});
  
  if (locationText == 'USE_PREVIOUS_ADDRESS' || locationText == 'Use previous address') {
    locationText = state.address;
  } else {
    try {
      locationText = yield formatAddress(locationText, suspend.resume());
    } catch(e) {
      yield bot.sendTextMessage(userId, INCORRECT_ADDRESS, suspend.resume());
      return null;
    }

    yield setState(userId, {address: locationText, trid: trid}); // save current address in case user confirms
      
  }
 
  var googleUrl = 'https://maps.googleapis.com/maps/api/staticmap' +
      '?markers=color:red' + encodeURIComponent('|' + locationText.formatted_address) +
      '&size=' + MAP_IMAGE_SIZE +
      '&zoom=15';
//       '&key=' + encodeURIComponent(config.maps_api_key);
  
  var uploadData = yield imgur.uploadUrl(googleUrl);
  var imageWithoutApiKey = uploadData.data.link;
  var mapLink = 'https://maps.google.com/?q=' + encodeURIComponent(locationText.formatted_address); // we have to display a map link according to Google's terms of service unless we use commercial API
  
  yield bot.sendGenericMessage(userId, [{
    title: DELIVERY_CONFIRMATION_TITLE,
    subtitle: DELIVERY_CONFIRMATION_INFO,
    image_url: imageWithoutApiKey,
    buttons: [
      {
        type:"web_url",
        title: "Show on bigger map",
        url: mapLink
      },
      {
        type: "web_url",
        title: "Confirm and pay",
        url: paymentUrl({trid: trid, prev: 1})
      },
      {
        type: "postback",
        title: "Start again",
        payload: "GET_STARTED"
      }
    ]
  }], suspend.resume());
});

var sendSlackMsg = suspend.promise(function*(userId, text) {
  var slack = new Slack();
  slack.setWebhook(config.slack_webhook);

  yield (slack.webhook(
    {username: 'pizzabot', text: text},
    suspend.resume()
  ) && 1); // don't return promise, because `suspend` has trouble with Slack's promises
});

var notifyHuman = suspend.promise(function*(userId) {
  var profile = yield bot.getUserProfile(userId, suspend.resume());
  var text = NOTIFY_HUMAN_TPL.replace('%username%', profile.first_name +" "+ profile.last_name) +"\n"+ profile.profile_pic;
  
  yield sendSlackMsg(userId, text);
});

var selectPizza = suspend.promise(function*(userId, payload) {
  var state = yield getState({userId: userId});

  var pizza = state.pizza || {};

  if (!pizza || Object.keys(pizza).length == 0) {
    var msg = {
      "text": ORDER_MULTIPLE_MSG,
      "quick_replies":[
        {
          "content_type":"text",
          "title":"Order",
          "payload":"ORDER"
        }
      ]
    };
    yield bot.send(userId, msg, suspend.resume());
  } else {
    var msg = {
      "text": PIZZAS[payload].data.title + " added to cart",
      "quick_replies":[
        {
          "content_type":"text",
          "title":"Order",
          "payload":"ORDER"
        }
      ]
    };
    yield bot.send(userId, msg, suspend.resume()); 
  }
  
  if (pizza[payload]) {
    pizza[payload]++;
  } else {
    pizza[payload] = 1; 
  }

  var trid = hash.generate(config.salt + '_' + userId);

  yield setState(userId, {
    pizza: pizza,
    trid: trid
  });
    
});

var handleOrder = suspend.promise(function*(userId, payload) {
  var state = yield getState({userId: userId});
  
//   if user does not have any selected pizza
  if (!state || !state.pizza || Object.keys(state.pizza).length == 0) {
    yield bot.sendTextMessage(userId, EMPTY_CARD, Bot.NOTIFICATION_TYPE.NO_PUSH, suspend.resume());
  } else {
    var trid = hash.generate(config.salt + '_' + userId);

    yield setState(userId, {
      state: STATE.CHOSE_PIZZA,
      trid: trid
    });

    state = yield getState({userId: userId});

    var order = '';
    for (var i in state.pizza) {
      order += PIZZAS[i].data.title + ': ' + state.pizza[i] + '\u000A';
    }

    if (state.address && state.address.formatted_address) {
      var msg = {
        "text": PROVIDE_ADDRESS_TEXT + ' ' + PREVIOUS_ADDRESS_TPL.replace('%address%', state.address.formatted_address),
        "quick_replies":[ 
          { 
            "content_type": "location" 
          },
          {
            "content_type": "text",
            "title": "Use previous address",
            "payload": "USE_PREVIOUS_ADDRESS"
          }
        ]
      };
      yield bot.send(userId, msg, suspend.resume());
    } else {
      yield bot.sendTextMessage(userId, PROVIDE_ADDRESS_TEXT, suspend.resume());
    }
  }
  
    
});

var handlePostback = suspend.promise(function*(userId, payload) {
  try {
    if (payload in PIZZAS) {
      yield selectPizza(userId, payload);
    } else {
      switch (payload) {
        case 'GET_STARTED':
          yield showIntro(userId);
        break;
        case 'ABOUT_US':
          yield showAboutUs(userId);
        break;
        case 'TALK_TO_HUMAN':
          yield bot.sendTextMessage(userId, HOLD_ON_TEXT, suspend.resume());
          yield notifyHuman(userId);
        break;      
        case 'ORDER':
          yield handleOrder(userId, payload);
        break;
        case 'USE_PREVIOUS_ADDRESS':
          yield showLocation(userId, payload);
        break;
        case 'MENU':
          yield showMenu(userId);
        break;
        default:
          console.log("Unknown payload from user", userId, payload);
      }
    }
  } catch(err) {
    console.log('Error:', error. err.stack);  
  }
});

var handleMessage = suspend.promise(function*(userId, message) {
  try {
    var data = yield getState({userId: userId});

    var msg = message.trim().toLowerCase();

    switch (msg) {
      case 'menu':
        data.state = 'MENU';
      break;
      case 'start':
        data.state = 'START';
      break;
      case 'order':
        data.state = 'ORDER';
      break;
    }

    switch (data.state) {
      case 'MENU':
        yield showMenu(userId);
      break;
      case 'START':
        yield startNew(userId);
      break;
      case 'SHOWN_INTRO':
        yield showDontUnderstand(userId);
      break;
      case 'CHOSE_PIZZA':
        yield showLocation(userId, message);
      break;
      case 'ORDER':
        yield handleOrder(userId, message);
      break;
      default:
        yield showIntro(userId);
    }
  } catch(err) {
    console.log('Error:', error. err.stack);
  }
});

var initGlobals = suspend.promise(function*(unit) {
  config = unit.config;

//   rootUrl = unit.req.uri.protocol + '://' + unit.req.uri.host + unit.req.url;
  rootUrl = 'https://' + unit.req.uri.host + unit.req.url;

  bot = new Bot({
    page_token: config.fb_access_token,
    verify_token: config.fb_verify_token
  });
  
  var url = 'mongodb://'+ config.mongo +'?authMechanism=SCRAM-SHA-1';
  mongo = yield MongoClient.connect(url);
  mongo.collection(STATE_COLLECTION).createIndex('userId', {unique:true, background:true});
  mongo.collection(STATE_COLLECTION).createIndex('trid', {unique:true, background:true});
});

var handleChat = suspend.promise(function*(unit) {
  try {
    yield initGlobals(unit);
    var messagingData = unit.req.body.entry[0].messaging;
    for (var k in messagingData) {
      var event = messagingData[k];
      if (event.message && event.message.text) {
        yield handleMessage(event.sender.id, event.message.text);
      } else if (event.postback && event.postback.payload) {
        yield handlePostback(event.sender.id, event.postback.payload);
      } else if (event.message && event.message.attachments) {
        var attachment = event.message.attachments[0];
        if (attachment && attachment.type == 'location') {
          yield showLocation(event.sender.id, attachment.payload);
        } else {
          console.log('Something is wrong');
          yield showDontUnderstand(event.sender.id);
        }
      } else {
        console.log('Something is wrong');
      }
    }
  } catch (err) {
    console.log('Error:', error. err.stack);
  }
  mongo && mongo.close();
  unit.resolve({});
});

module.exports = function(unit) {
  var parts = unit.req.url.split('/'); // 'user.unit.run/fb-bot/path' -> ['', 'fb-bot', 'path']

  if (unit.req.method === 'GET') {
    unit.resolve(unit.req.query['hub.challenge']);
  } else {
    handleChat(unit);
  }
  
};
