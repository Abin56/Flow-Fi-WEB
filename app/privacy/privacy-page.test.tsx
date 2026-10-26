// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "./page";

describe("/privacy", () => {
  afterEach(cleanup);

  it("states the AI default and the candidate boundary", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/off by default/)).toBeTruthy();
    expect(screen.getAllByText(/Anthropic/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("A candidate does not contain the message text");
  });

  it("links every contact mention to the official FlowFi email", () => {
    render(<PrivacyPage />);
    const links = screen.getAllByTestId("privacy-contact");
    expect(links.length).toBe(3); // deletion request, data access request, Contact section
    for (const link of links) {
      expect(link.textContent).toBe("abinjohn.dev@gmail.com");
      expect(link.getAttribute("href")).toBe("mailto:abinjohn.dev@gmail.com");
    }
    expect(document.body.textContent).not.toContain("not configured");
  });
});
