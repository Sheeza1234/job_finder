const providers = [require('./remotive'), require('./remoteok'), require('./jobicy'), require('./himalayas'), require('./jooble'), require('./jsearch')];
module.exports = {
  all: providers,
  status: () => providers.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled() })),
};
