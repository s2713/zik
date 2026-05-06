/// <reference types="vite/client" />

// Vite ?inline suffix — import CSS file content as a raw string.
declare module "*.css?inline" {
  const content: string;
  export default content;
}