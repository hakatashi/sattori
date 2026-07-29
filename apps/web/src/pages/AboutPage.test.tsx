import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AboutPage } from "./AboutPage.tsx";

describe("AboutPage", () => {
  it("見出しと作者のソーシャルリンクを表示する", () => {
    render(<AboutPage />);

    expect(screen.getByRole("heading", { name: "Sattoriについて" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://github.com/hakatashi" })).toHaveProperty(
      "href",
      "https://github.com/hakatashi",
    );
    expect(screen.getByRole("link", { name: "https://x.com/hakatashi" })).toHaveProperty(
      "href",
      "https://x.com/hakatashi",
    );
    expect(screen.getByRole("link", { name: "hakatasiloving@gmail.com" })).toHaveProperty(
      "href",
      "mailto:hakatasiloving@gmail.com",
    );
  });
});
