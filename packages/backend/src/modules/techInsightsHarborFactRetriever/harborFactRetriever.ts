import {
  CatalogClient,
  CATALOG_FILTER_EXISTS,
} from '@backstage/catalog-client';
import { Entity } from '@backstage/catalog-model';
import { FactRetriever } from '@backstage-community/plugin-tech-insights-node';

/**
 * M-1 drift experiment. See plan/m-1-backstage-validation-plan.md §6b and §6c.
 *
 * The comparison deliberately lives HERE, not in the json-rules-engine check,
 * because a check's `value:` is a literal in app-config and cannot reference
 * this entity's baseline. We emit a precomputed boolean plus both operands; the
 * check degenerates to `matchesBaseline equals true`. That is the finding, not
 * a workaround to be tidied away later.
 */

export const HARBOR_PROJECT_ANNOTATION = 'harbor.io/project';
export const HARBOR_BASELINE_ANNOTATION = 'devsecops/harbor-baseline';

/** The two drift candidates chosen in §2. Both are booleans-as-strings in Harbor. */
const TRACKED_FIELDS = ['auto_scan', 'public'] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

type HarborProject = {
  project_id: number;
  name: string;
  metadata?: Record<string, string>;
};

/**
 * Harbor stores these as the strings 'true'/'false'. The baseline annotation is
 * hand-written JSON and may use real booleans, so normalise both sides before
 * comparing — otherwise every entity reads as drifted and the experiment lies.
 */
const normalise = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value);

const parseBaseline = (entity: Entity): Record<string, string | undefined> => {
  const raw = entity.metadata.annotations?.[HARBOR_BASELINE_ANNOTATION];
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, normalise(value)]),
    );
  } catch {
    return {};
  }
};

export const harborConfigFactRetriever: FactRetriever = {
  id: 'harborConfigFactRetriever',
  version: '0.1.0',
  title: 'Harbor configuration drift',
  description:
    'Compares a Harbor project config against the baseline captured on the entity at onboarding.',
  entityFilter: [
    {
      kind: 'component',
      [`metadata.annotations.${HARBOR_PROJECT_ANNOTATION}`]:
        CATALOG_FILTER_EXISTS,
    },
  ],
  schema: {
    autoScanMatchesBaseline: {
      type: 'boolean',
      description: 'auto_scan in Harbor still equals the onboarding baseline',
    },
    autoScanObserved: {
      type: 'string',
      description: 'auto_scan as Harbor currently reports it',
    },
    autoScanBaseline: {
      type: 'string',
      description: 'auto_scan as captured at onboarding',
    },
    publicMatchesBaseline: {
      type: 'boolean',
      description: 'public in Harbor still equals the onboarding baseline',
    },
    publicObserved: {
      type: 'string',
      description: 'public as Harbor currently reports it',
    },
    publicBaseline: {
      type: 'string',
      description: 'public as captured at onboarding',
    },
    driftedFieldCount: {
      type: 'integer',
      description: 'Number of tracked fields that no longer match the baseline',
    },
    observationFailed: {
      type: 'boolean',
      description:
        'Harbor could not be reached or the project is gone - the facts below are stale, not clean',
    },
  },
  handler: async ctx => {
    const { discovery, config, logger, auth } = ctx;

    const harborBaseUrl = config
      .getString('devsecops.harbor.baseUrl')
      .replace(/\/+$/, '');
    const harborAuth = Buffer.from(
      `${config.getString('devsecops.harbor.username')}:${config.getString(
        'devsecops.harbor.password',
      )}`,
    ).toString('base64');

    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    const catalogClient = new CatalogClient({ discoveryApi: discovery });
    const { items: entities } = await catalogClient.getEntities(
      {
        filter: [
          {
            kind: 'component',
            [`metadata.annotations.${HARBOR_PROJECT_ANNOTATION}`]:
              CATALOG_FILTER_EXISTS,
          },
        ],
      },
      { token },
    );

    return await Promise.all(
      entities.map(async entity => {
        const projectName =
          entity.metadata.annotations![HARBOR_PROJECT_ANNOTATION];
        const baseline = parseBaseline(entity);

        let observed: Record<string, string | undefined> = {};
        let observationFailed = false;

        try {
          // One GET per entity. If a tracked field ever needs the retention
          // endpoint too, that is the §2 "one logical config spans multiple API
          // calls" finding and belongs in the write-up.
          const response = await fetch(
            `${harborBaseUrl}/api/v2.0/projects/${encodeURIComponent(
              projectName,
            )}`,
            { headers: { Authorization: `Basic ${harborAuth}` } },
          );
          if (!response.ok) {
            throw new Error(`Harbor responded ${response.status}`);
          }
          const project = (await response.json()) as HarborProject;
          observed = Object.fromEntries(
            TRACKED_FIELDS.map(field => [
              field,
              normalise(project.metadata?.[field]),
            ]),
          );
        } catch (error) {
          // Note for §8b: a deleted Harbor project and an unreachable Harbor
          // are indistinguishable to a fact retriever without more work.
          observationFailed = true;
          logger.warn(
            `Harbor observation failed for ${entity.metadata.name} (project ${projectName}): ${error}`,
          );
        }

        const matches = (field: TrackedField) =>
          !observationFailed &&
          baseline[field] !== undefined &&
          baseline[field] === observed[field];

        const driftedFieldCount = observationFailed
          ? 0
          : TRACKED_FIELDS.filter(field => !matches(field)).length;

        return {
          entity: {
            // Required to be a string, unlike the README example.
            namespace: entity.metadata.namespace ?? 'default',
            kind: entity.kind,
            name: entity.metadata.name,
          },
          facts: {
            autoScanMatchesBaseline: matches('auto_scan'),
            autoScanObserved: observed.auto_scan ?? 'unknown',
            autoScanBaseline: baseline.auto_scan ?? 'unset',
            publicMatchesBaseline: matches('public'),
            publicObserved: observed.public ?? 'unknown',
            publicBaseline: baseline.public ?? 'unset',
            driftedFieldCount,
            observationFailed,
          },
        };
      }),
    );
  },
};
