// `import text from "./file.md?raw"`: the file's contents as a string, inlined by the Workers' bundler (alchemy's rolldown,
// its `?raw` plugin) and by Vite in Vitest. The bundled skills (`workspace/bundled-skills.generated.ts`) are imported this way.
declare module "*?raw" {
  const text: string;

  export default text;
}
