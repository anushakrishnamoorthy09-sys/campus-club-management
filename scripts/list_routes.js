const app = require('../src/app');

function printRouteTable() {
  const routes = [];

  function extractRoutes(stack, basePath = '') {
    stack.forEach((layer) => {
      if (layer.route) {
        // Direct route
        const path = (basePath + layer.route.path).replace(/\/+/g, '/');
        const methods = Object.keys(layer.route.methods)
          .map((m) => m.toUpperCase())
          .join(', ');

        const guards = [];
        layer.route.stack.forEach((handlerLayer) => {
          const fn = handlerLayer.handle;
          if (fn.__guardType) {
            if (fn.__guardType === 'requireRole') {
              guards.push(`requireRole(${fn.__roles.join(', ')})`);
            } else if (fn.__guardType === 'requirePermission') {
              guards.push(`requirePermission('${fn.__permission}')`);
            } else {
              guards.push(fn.__guardType);
            }
          }
        });

        routes.push({
          method: methods,
          path: path,
          guard: guards.length > 0 ? guards.join(' | ') : '[PUBLIC / UNGUARDED]'
        });
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // Router middleware mounted with app.use
        let matchPath = '';
        if (layer.regexp && layer.regexp.source) {
          // Extract prefix if any
          const src = layer.regexp.source;
          if (src !== '^\\/?(?=\\/|$)' && src !== '^\\/') {
            matchPath = src
              .replace('^\\/', '')
              .replace('\\/?(?=\\/|$)', '')
              .replace('(?=\\/|$)', '')
              .replace(/\\\//g, '/');
            if (matchPath && !matchPath.startsWith('/')) {
              matchPath = '/' + matchPath;
            }
          }
        }
        extractRoutes(layer.handle.stack, basePath + matchPath);
      }
    });
  }

  if (app._router && app._router.stack) {
    extractRoutes(app._router.stack);
  }

  console.log('\n========================================================================================');
  console.log('                            CAMPUSCLUBOS ROUTE AUDIT TABLE                              ');
  console.log('========================================================================================\n');
  console.table(routes);
  console.log('\nAudit complete. Total registered endpoints:', routes.length);
  console.log('========================================================================================\n');
}

printRouteTable();
