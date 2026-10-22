// The bundler (alchemy's rolldown) inlines `?raw` imports as strings.
declare module "*?raw" {
  const text: string;
  export default text;
}

// alchemy.run.ts runs under Node.
interface ImportMeta {
  readonly url: string;
}
