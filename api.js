'use strict';

module.exports = {
  // Brukes av innstillingssiden for å bekrefte adressen før den lagres.
  // Selve testen ligger i app.js, siden paringen bruker den samme.
  async testProxy({ homey, query }) {
    return homey.app.testProxyConnection(
      String(query.host || '').trim(),
      Number(query.port || 6053),
    );
  },
};
