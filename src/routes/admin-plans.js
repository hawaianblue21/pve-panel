// Admin portal: plans (server sizes with a monthly price) and the plan setting.
import { db, audit } from '../db.js';
import { listPlans, createPlan, updatePlan, deletePlan, planSettings, savePlanSettings } from '../plans.js';

const PLAN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 60 },
    description: { type: 'string', maxLength: 200 },
    cores: { type: 'integer' },
    memoryMb: { type: 'integer' },
    diskGb: { type: 'integer' },
    gpuProfileId: { type: ['integer', 'null'] },
    priceMonthly: { type: ['integer', 'null'] },
    active: { type: 'boolean' },
    sort: { type: 'integer' },
  },
};
const ID = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } };

export default async function adminPlanRoutes(app) {
  app.get('/api/admin/plans', async () => ({
    plans: listPlans(),
    settings: planSettings(),
    gpuProfiles: db.prepare('SELECT id, name FROM gpu_profiles ORDER BY name').all(),
  }));

  app.post('/api/admin/plans', { schema: { body: { ...PLAN, required: ['name', 'cores', 'memoryMb', 'diskGb'] } } }, async (req, reply) => {
    const plan = createPlan(req.body);
    audit(req, null, 'admin_plan_create', plan);
    return reply.code(201).send(plan);
  });

  app.put('/api/admin/plans/:id', { schema: { params: ID, body: PLAN } }, async (req) => {
    const plan = updatePlan(req.params.id, req.body);
    audit(req, null, 'admin_plan_update', { id: plan.id, ...req.body });
    return plan;
  });

  app.delete('/api/admin/plans/:id', { schema: { params: ID } }, async (req) => {
    const r = deletePlan(req.params.id);
    audit(req, null, 'admin_plan_delete', { id: req.params.id });
    return r;
  });

  app.put('/api/admin/settings/plans', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { requirePlan: { type: 'boolean' } } } },
  }, async (req) => {
    const s = savePlanSettings(req.body);
    audit(req, null, 'admin_plan_settings', s);
    return s;
  });
}
