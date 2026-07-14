import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { ensureQrImagePath } from '../shared/pix/pixExtract.js';
import { resolveWhatsAppGroupId, sendBaileysToGroup } from '../shared/whatsapp/whatsappBaileys.js';

const log = createLogger('whatsapp-test');

const emv =
  '00020126180014br.gov.bcb.pix5204000053039865802BR5911Ebanx LTDA.6008CURITIBA62070503***80720014br.gov.bcb.pix2550pix.ebanx.com/rec/TEST12363047DB8';

try {
  const groupId = await resolveWhatsAppGroupId({ log });
  const qrImagePath = await ensureQrImagePath({ copyPaste: emv, email: 'test', log });
  const result = await sendBaileysToGroup({ groupId, text: emv, qrImagePath, log });
  log.info('Teste OK:', JSON.stringify(result));
  process.exit(0);
} catch (err) {
  log.error('Teste falhou:', err.message);
  process.exit(1);
}
