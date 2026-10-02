import { expect, it } from "vitest";
import { addressFromHash } from "../web/address.ts";

it("reads the host token and url from the fragment, defaulting the url", () => {
  expect(addressFromHash("#token=abc")).toEqual({ url: "ws://127.0.0.1:7420", token: "abc" });
  expect(addressFromHash("#token=a%2Bb&url=ws%3A%2F%2F127.0.0.1%3A9000")).toEqual({ url: "ws://127.0.0.1:9000", token: "a+b" });
  expect(addressFromHash("")).toBeUndefined();
});
