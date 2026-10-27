// What the Skill tests on a Workspace share (`env.workerd.test.ts`, `skills.workerd.test.ts`). It is not a test file, so
// importing it registers no tests.
// @effect-diagnostics missingPipeableSignature:off

/** A Skill's `SKILL.md`: its frontmatter (`name`, `description`), then `body`. */
export const skillFile = (name: string, description = `The ${name} skill.`, body = `# ${name}`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
