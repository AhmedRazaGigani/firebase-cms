/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const express = require('express');
const exphbs = require('express-handlebars');
const app = express();
const firebaseUser = require('./firebaseUser');
const logging = require('@google-cloud/logging')();
const db = admin.database();

let hbsHelpers = exphbs.create({
  helpers: require("./helpers.js").helpers,
  defaultLayout: 'main',
  extname: '.handlebars'
});

app.engine('handlebars', hbsHelpers.engine);
app.set('view engine', 'handlebars');
app.use(firebaseUser.validateFirebaseIdToken);

let menu = [];
let cart = [];

let getCartItems = (req) => {
  db.ref('users/' + req.user.user_id + '/cart').once('value', (snapshot) => {
    let cartArray = Object.keys(snapshot.val()).map(function(key) {
      return snapshot.val()[key];
    });
    cart = cartArray;
  });
};

let getNavItems = () => {
  db.ref('menus/nav').once('value', (snapshot) => {
    menu = snapshot.val();
  });
};

app.get('/', (req, res) => {
  getNavItems();
  db.ref('products').once('value', (snapshot) => {
    res.render('products/products', {
      user: req.user,
      nav: menu,
      products: snapshot.val()
    });
  });
});

app.get('/product/:slug', (req, res) => {
  getNavItems();
  getCartItems(req);
  let productSlug = req.path.split('/product/')[1];
  db.ref('products').orderByChild('url').equalTo(productSlug).once('value', (snapshot) => {
    res.render('product/product', {
      user: req.user,
      nav: menu,
      product: snapshot.val()[Object.keys(snapshot.val())[0]],
      cart: cart
    });
  });
});

app.get('/blog', (req, res) => {
  getNavItems();
  db.ref('posts').once('value', (snapshot) => {
    res.render('posts/posts', {
      user: req.user,
      nav: menu,
      posts: snapshot.val()
    });
  });
});

app.get('/blog/:slug', (req, res) => {
  getNavItems();
  let postSlug = req.path.split('/blog/')[1];
  db.ref('posts').orderByChild('url').equalTo(postSlug).once('value', (snapshot) => {
    res.render('post/post', {
      user: req.user,
      nav: menu,
      post: snapshot.val()[Object.keys(snapshot.val())[0]]
    });
  });
});

app.get('/page/:slug', (req, res) => {
  getNavItems();
  let pageSlug = req.path.split('/page/')[1];
  db.ref('pages').orderByChild('url').equalTo(pageSlug).once('value', (snapshot) => {
    res.render('page/page', {
      user: req.user,
      nav: menu,
      page: snapshot.val()[Object.keys(snapshot.val())[0]]
    });
  });
});

app.get('/account/orders', (req, res) => {
  getNavItems();
  db.ref('users/' + req.user.user_id + '/orders').once('value', (snapshot) => {
    res.render('orders/orders', {
      user: req.user,
      nav: menu,
      orders: snapshot.val()
    });
  });
});

app.get('/account/order/:key', (req, res) => {
  getNavItems();
  let orderKey = req.path.split('/account/order/')[1];
  db.ref('orders/' + orderKey).once('value', (snapshot) => {
    res.render('order/order', {
      user: req.user,
      nav: menu,
      order: snapshot.val(),
      orderKey: orderKey
    });
  });
});

app.get('/cart', (req, res) => {
  getNavItems();
  if (req) {
    db.ref(`users/${req.user.user_id}/cart`).once('value', (snapshot) => {
      res.render('cart/cart', {
        user: req.user,
        nav: menu,
        cart: snapshot.val() || null
      });
    });
  }
});

app.get('/checkout/shipping', (req, res) => {
  getNavItems();
  res.render('checkout-shipping/checkout-shipping', {
    user: req.user,
    nav: menu
  });
});

app.get('/checkout/billing', (req, res) => {
  getNavItems();
  res.render('checkout-billing/checkout-billing', {
    user: req.user,
    nav: menu
  });
});

app.get('/user', (req, res) => {
  console.log('Signed-in user:', req.user);
  res.render('user', {
    user: req.user
  });
});

// This HTTPS endpoint can only be accessed by your Firebase Users.
// Requests need to be authorized by providing an `Authorization` HTTP header
// with value `Bearer <Firebase ID Token>`.
exports.app = functions.https.onRequest(app);

const stripe = require('stripe')(functions.config().stripe.token),
      currency = functions.config().stripe.currency || 'USD';

// [START chargecustomer]
// Charge the Stripe customer whenever an amount is written to the Realtime database
exports.createStripeCharge = functions.database.ref('/stripe_customers/{userId}/charges/{id}').onWrite(event => {
  const val = event.data.val();
  // This onWrite will trigger whenever anything is written to the path, so
  // noop if the charge was deleted, errored out, or the Stripe API returned a result (id exists) 
  if (val === null || val.id || val.error) return null;
  // Look up the Stripe customer id written in createStripeCustomer
  return admin.database().ref(`/stripe_customers/${event.params.userId}/customer_id`).once('value').then(snapshot => {
    return snapshot.val();
  }).then(customer => {
    // Create a charge using the pushId as the idempotency key, protecting against double charges 
    const amount = val.amount;
    const idempotency_key = event.params.id;
    let charge = {amount, currency, customer};
    if (val.source !== null) charge.source = val.source;
    return stripe.charges.create(charge, {idempotency_key});
  }).then(response => {
      // If the result is successful, write it back to the database
      return event.data.adminRef.set(response);
    }, error => {
      // We want to capture errors and render them in a user-friendly way, while
      // still logging an exception with Stackdriver
      return event.data.adminRef.child('error').set(userFacingMessage(error)).then(() => {
        return reportError(error, {user: event.params.userId});
      });
    }
  );
});
// [END chargecustomer]]

// When a user is created, register them with Stripe
exports.createTheStripeCustomer = functions.auth.user().onCreate(event => {
  const data = event.data;
  return stripe.customers.create({
    email: data.email
  }).then(customer => {
    return admin.database().ref(`/stripe_customers/${data.uid}/customer_id`).set(customer.id);
  });
});

// Add a payment source (card) for a user by writing a stripe payment source token to Realtime database
exports.addPaymentSource = functions.database.ref('/stripe_customers/{userId}/sources/{pushId}/token').onWrite(event => {
  const source = event.data.val();
  if (source === null) return null;
  return admin.database().ref(`/stripe_customers/${event.params.userId}/customer_id`).once('value').then(snapshot => {
    return snapshot.val();
  }).then(customer => {
    return stripe.customers.createSource(customer, {source});
  }).then(response => {
      return event.data.adminRef.parent.set(response);
    }, error => {
      return event.data.adminRef.parent.child('error').set(userFacingMessage(error)).then(() => {
        return reportError(error, {user: event.params.userId});
      });
  });
});

// When a user deletes their account, clean up after them
exports.cleanupUser = functions.auth.user().onDelete(event => {
  return admin.database().ref(`/stripe_customers/${event.data.uid}`).once('value').then(snapshot => {
    return snapshot.val();
  }).then(customer => {
    return stripe.customers.del(customer);
  }).then(() => {
    return admin.database().ref(`/stripe_customers/${event.data.uid}`).remove();
  });
});

// To keep on top of errors, we should raise a verbose error report with Stackdriver rather
// than simply relying on console.error. This will calculate users affected + send you email
// alerts, if you've opted into receiving them.
// [START reporterror]
function reportError(err, context = {}) {
  // This is the name of the StackDriver log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by StackDriver Error Reporting.
  const logName = 'errors';
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: { function_name: process.env.FUNCTION_NAME }
    }
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: 'cloud_function'
    },
    context: context
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), error => {
      if (error) { reject(error); }
      resolve();
    });
  });
}
// [END reporterror]

// Sanitize the error message for the user
function userFacingMessage(error) {
  return error.type ? error.message : 'An error occurred, developers have been alerted';
}

const nodemailer = require('nodemailer');
// Configure the email transport using the default SMTP transport and a GMail account.
// For other types of transports such as Sendgrid see https://nodemailer.com/transports/
// TODO: Configure the `gmail.email` and `gmail.password` Google Cloud environment variables.
const gmailEmail = encodeURIComponent(functions.config().gmail.email);
const gmailPassword = encodeURIComponent(functions.config().gmail.password);
const mailTransport = nodemailer.createTransport(
    `smtps://${gmailEmail}:${gmailPassword}@smtp.gmail.com`);

// Sends an email confirmation when a user is added as an admin
exports.sendEmailConfirmation = functions.database.ref('/admins/{id}').onWrite(event => {
  const snapshot = event.data;
  const val = snapshot.val();

  if (!snapshot.changed('active')) {
    return;
  }

  const mailOptions = {
    from: '"FireShop" <noreply@firebase.com>',
    to: val.email
  };

  if (!val.active) {
    mailOptions.subject = 'Admin Confirmation';
    mailOptions.html = '<h2>FireShop</h2>You have been added as an admin to FireShop. <br><br>Sign in now: https://' + process.env.GCLOUD_PROJECT + '.firebaseapp.com/register';
    return mailTransport.sendMail(mailOptions).then(() => {
      console.log('New admin confirmation email sent to:', val.email);
    }).catch(error => {
      console.error('There was an error while sending the email:', error);
    });
  }
});

// Sends an email confirmation when a user places an order
exports.sendOrderConfirmation = functions.database.ref('/users/{uid}/orders/{orderId}').onCreate(event => {
  const snapshot = event.data;
  return event.data.ref.parent.parent.once("value").then(snap => {
    const user = snap.val();
    const email = user.email;

    if (email) {
      const mailOptions = {
        from: '"FireShop" <noreply@firebase.com>',
        to: email
      };
      mailOptions.subject = 'Order Confirmation';
      mailOptions.html = '<h2>FireShop</h2>Order #' + event.params.orderId + '. This is a confirmation email for you order on FireShop. <br><br>';
      mailOptions.html += 'View order details and status by logging in: https://' + process.env.GCLOUD_PROJECT + '.firebaseapp.com/account/order/' + event.params.orderId;
      return mailTransport.sendMail(mailOptions).then(() => {
        console.log('New order confirmation email sent to:', email);
      }).catch(error => {
        console.error('There was an error while sending the email:', error);
      });
    }
  });

});