import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { BUILTIN_SKILLS, findBuiltinSkill } from './skills/builtin.js';

/**
 * Skills — procedures somebody taught the assistant once.
 *
 * "How we write a quotation", "how invoices get filed". Without them a repeated
 * job has to be re-explained every conversation, and the explanation drifts.
 *
 * The design decision worth knowing: **only the names and descriptions go into
 * the system prompt**, not the instructions. Twenty skills of full instructions
 * would be thousands of tokens on every single turn, most of it irrelevant. The
 * model sees a menu, and reads the one it needs with `skill_read`. That is also
 * why the description matters more than the title — it is what the model uses
 * to decide.
 */

const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_INSTRUCTIONS = 20_000;

export async function saveSkill(userId, { name, description, instructions }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A skill needs a name.');
  if (clean.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters.`);

  const why = String(description || '').trim();
  if (!why) {
    throw new Error(
      'A skill needs a description — it is how the assistant decides when this applies, so say what it is for.',
    );
  }
  if (why.length > MAX_DESCRIPTION) throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters.`);

  const steps = String(instructions || '').trim();
  if (!steps) throw new Error('A skill needs instructions — the actual procedure.');
  if (steps.length > MAX_INSTRUCTIONS) throw new Error('That is too long for one skill; split it up.');

  return getStore().saveSkill(userId, {
    id: crypto.randomUUID(),
    name: clean,
    description: why,
    instructions: steps,
  });
}

/**
 * The menu that goes into the system prompt.
 *
 * Returns null when there is nothing to offer, so the caller can leave the
 * section out entirely rather than printing an empty heading.
 */
export async function skillMenu(userId) {
  const skills = await getStore().listSkills(userId, true);

  /**
   * The built-in procedures come first, and they are always there.
   *
   * `create_file` can write Word, Excel and PowerPoint, and its description says
   * so — but the *conventions* were nowhere. A description long enough to carry
   * them would be thousands of tokens on every request, so the model knew it could
   * make a spreadsheet and did not know that a heading above a table starts a new
   * sheet. That is precisely the problem skills already solve: a cheap menu, and
   * the instructions read only when they apply.
   */
  const lines = [
    ...BUILTIN_SKILLS.map((s) => `- **${s.name}** — ${s.description}`),
    ...skills.map((s) => `- **${s.name}** — ${s.description}`),
  ];

  return [
    'Procedures you can read with `skill_read` before starting a job of that kind. Read the',
    'relevant one **first**: it carries conventions you cannot infer, and the ones the user',
    'wrote are how they want the job done.',
    '',
    ...lines,
  ].join('\n');
}

export async function readSkill(userId, name) {
  const wanted = String(name || '').trim().toLowerCase();

  // Built-ins are checked first and are not recorded as used: the counter exists
  // to tell somebody which of *their* skills is earning its keep.
  const builtin = findBuiltinSkill(wanted);
  if (builtin) {
    return [`# ${builtin.name}`, '', builtin.description, '', '---', '', builtin.instructions].join('\n');
  }

  const skills = await getStore().listSkills(userId, true);
  const found = skills.find((s) => s.name.toLowerCase() === wanted);

  if (!found) {
    const available = [...BUILTIN_SKILLS.map((s) => s.name), ...skills.map((s) => s.name)].join(', ');
    throw new Error(`No skill called "${name}". Available: ${available}`);
  }

  await getStore().noteSkillUsed(userId, found.name);
  return [`# ${found.name}`, '', found.description, '', '---', '', found.instructions].join('\n');
}
