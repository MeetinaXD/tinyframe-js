# TinyFrameJS

TypeScript reimplementation of [MightyPork/TinyFrame](https://github.com/MightyPork/TinyFrame).

- Original author: `@cpsdqs`
- Current maintainer: [@MeetinaXD](https://github.com/MeetinaXD)

## Background

The original JavaScript port is no longer available, so this repository reconstructs the protocol runtime in TypeScript and adds a Vitest suite that exercises checksum variants, request/response flows, and all listener types.

During the rewrite several legacy issues were fixed:

- Frame assembly used bitwise `&` instead of `|`, corrupting peer flag propagation.
- After validating the header checksum the parser state was not reset, and it never entered the `data` phase correctly when payloads existed.
- Buffer length accounting included checksum bytes twice, so transmitted payloads were truncated.

## Development

```bash
pnpm install
pnpm run build  # produce ESM+CJS bundles via tsdown
pnpm test       # run vitest
```

## License

This project continues to use the [MIT](./LICENSE)  License defined by `@cpsdqs`.
