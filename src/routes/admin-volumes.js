// Admin: block storage tiers and limits (Settings), and every customer's volumes.
import { audit } from '../db.js';
import { adminVolumes, volumeSettings, saveVolumeSettings } from '../volumes.js';

export default async function adminVolumeRoutes(app) {
  app.get('/api/admin/volumes', async () => adminVolumes());

  app.get('/api/admin/settings/volumes', async () => volumeSettings());

  app.put('/api/admin/settings/volumes', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' }, maxSizeGb: { type: 'integer' }, maxPerServer: { type: 'integer' },
          tiers: {
            type: 'array', maxItems: 6,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', maxLength: 20 }, name: { type: 'string', maxLength: 40 }, description: { type: 'string', maxLength: 120 },
                storage: { type: 'string', maxLength: 100 }, pricePerGb: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const saved = saveVolumeSettings(req.body);
    audit(req, null, 'admin_volume_settings', req.body);
    return saved;
  });
}
