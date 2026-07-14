import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { hasSavedSession, listBaileysGroups } from '../shared/whatsapp/whatsappBaileys.js';

/**
 * Lista grupos WhatsApp para copiar WHATSAPP_GROUP_ID.
 *   npm run whatsapp:groups
 */
const log = createLogger('whatsapp-groups');

if (!hasSavedSession()) {
  log.error('Sem sessao. Rode primeiro: npm run whatsapp:login');
  process.exit(1);
}

try {
  const groups = await listBaileysGroups({ log });
  if (!groups.length) {
    log.warn('Nenhum grupo encontrado.');
    process.exit(0);
  }

  console.log('\n=== GRUPOS ===\n');
  groups
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .forEach((g) => {
      console.log(`${g.subject}`);
      console.log(`  id: ${g.id}`);
      console.log(`  membros: ${g.participants}\n`);
    });

  console.log('Copie o id para WHATSAPP_GROUP_ID no .env');
  process.exit(0);
} catch (err) {
  log.error('Falha:', err.message);
  process.exit(1);
}
