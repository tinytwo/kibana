/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';
import { wrapError } from './errors';

/**
 * Creates a hapi authenticate function that conditionally redirects
 * on auth failure.
 * @param {Hapi.Server} server HapiJS Server instance.
 * @returns {Function} Authentication function that will be called by Hapi for every
 * request that needs to be authenticated.
 */
export function authenticateFactory(server) {

  // Sometimes authentication subsystem may require some special headers to be sent back to
  // the client with the requested payload (e.g. for mutual client-server authentication).
  const authResponseHeadersMap = new WeakMap();
  server.ext('onPreResponse', (request, h) => {
    const authResponseHeaders = authResponseHeadersMap.get(request);
    if (authResponseHeaders) {
      const response = request.response;
      if (Boom.isBoom(response)) {
        response.output.headers = {
          ...response.output.headers,
          ...authResponseHeaders,
        };
      } else {
        for (const [headerName, headerValue] of Object.entries(authResponseHeaders)) {
          response.header(headerName, headerValue);
        }
      }
    }

    return h.continue;
  });

  return async function authenticate(request, h) {
    // If security is disabled continue with no user credentials
    // and delete the client cookie as well.
    const xpackInfo = server.plugins.xpack_main.info;
    if (xpackInfo.isAvailable() && !xpackInfo.feature('security').isEnabled()) {
      return h.authenticated({ credentials: {} });
    }

    let authenticationResult;
    try {
      authenticationResult = await server.plugins.security.authenticate(request);
    } catch (err) {
      server.log(['error', 'authentication'], err);
      return wrapError(err);
    }

    // Remember authentication related response headers and attach them to response in the
    // `onPreResponse` hook.
    if (authenticationResult.authResponseHeaders) {
      authResponseHeadersMap.set(request, authenticationResult.authResponseHeaders);
    }

    if (authenticationResult.succeeded()) {
      return h.authenticated({ credentials: authenticationResult.user });
    }

    if (authenticationResult.redirected()) {
      // Some authentication mechanisms may require user to be redirected to another location to
      // initiate or complete authentication flow. It can be Kibana own login page for basic
      // authentication (username and password) or arbitrary external page managed by 3rd party
      // Identity Provider for SSO authentication mechanisms. Authentication provider is the one who
      // decides what location user should be redirected to.
      return h.redirect(authenticationResult.redirectURL).takeover();
    }

    if (authenticationResult.failed()) {
      server.log(
        ['info', 'authentication'],
        `Authentication attempt failed: ${authenticationResult.error.message}`
      );

      return  wrapError(authenticationResult.error);
    }

    return Boom.unauthorized();
  };
}
