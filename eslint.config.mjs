// One rule only: the FSD import direction in apps/desktop/src (ADR-0016,
// ADR-0045). app → pages → widgets → features → entities → shared; a layer may
// import only the layers below it. Type-only imports are allowed, so a lower
// layer can name a type defined higher up without depending on its code.
// dev/, fixtures/, test/ and *.test.* files are not in any layer and may import
// anything.
import tseslint from "typescript-eslint";

const src = "apps/desktop/src";
const layers = ["shared", "entities", "features", "widgets", "pages", "app"];

function layerDirection(layer) {
  const above = layers.slice(layers.indexOf(layer) + 1);
  const message = `${layer} must not import from ${above.join(", ")} (ADR-0045 §1).`;

  return {
    files: [`${src}/${layer}/**/*.{ts,tsx}`],
    ignores: ["**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: above.flatMap((name) => [`@/${name}`, `@/${name}/**`]),
              allowTypeImports: true,
              message,
            },
            {
              // Relative paths that climb out of the layer into a higher one.
              regex: `^(\\.\\./)+(${above.join("|")})(/|$)`,
              allowTypeImports: true,
              message,
            },
          ],
        },
      ],
    },
  };
}

export default [
  {
    files: [`${src}/**/*.{ts,tsx}`],
    languageOptions: { parser: tseslint.parser },
  },
  ...layers.slice(0, -1).map(layerDirection),
];
