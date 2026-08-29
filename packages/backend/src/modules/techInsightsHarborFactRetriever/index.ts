import { createBackendModule } from '@backstage/backend-plugin-api';
import { techInsightsFactRetrieversExtensionPoint } from '@backstage-community/plugin-tech-insights-node';
import { harborConfigFactRetriever } from './harborFactRetriever';

export default createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'harbor-fact-retriever',
  register(reg) {
    reg.registerInit({
      deps: { providers: techInsightsFactRetrieversExtensionPoint },
      async init({ providers }) {
        providers.addFactRetrievers({ harborConfigFactRetriever });
      },
    });
  },
});
