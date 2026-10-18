import { describe, expect, it } from "bun:test";
import { classifyHubError } from "../src/hubError";

// The shapes hubclient.rs produces; the error screen's heading depends on telling them apart.
describe("classifyHubError", () => {
  it("names the cause from the message Rust sends", () => {
    expect(classifyHubError("hub http://h:1: bad token").heading).toBe("The hub refused the token.");
    expect(
      classifyHubError("hub http://h:1 is at schema 31, this app is at 30: run the same build")
        .heading,
    ).toBe("The hub runs a different Tildone build.");
    expect(classifyHubError("hub http://h:1: unreachable: connection refused").heading).toBe(
      "Couldn’t reach the hub.",
    );
    expect(classifyHubError("hub http://h:1: refused (Origin/Host)").heading).toBe(
      "The hub refused this address.",
    );
    expect(classifyHubError("Error: something else").kind).toBe("unreachable");
  });
});
