import { render, screen } from "@testing-library/react";
import { iconHtml } from "../test/iconHtml";
import { EnergyTile } from "./EnergyTile";

describe("EnergyTile", () => {
  it("shows today's energy", () => {
    render(<EnergyTile energy={{ kwh: 3.25, estimated: false, no_data: false }} />);
    expect(screen.getByText("Energy today")).toBeInTheDocument();
    expect(screen.getByText(/3\.25 kWh/)).toBeInTheDocument();
    expect(screen.queryByText("(estimated)")).not.toBeInTheDocument();
  });

  it("explains on hover what (estimated) means", () => {
    render(<EnergyTile energy={{ kwh: 3.25, estimated: true, no_data: false }} />);
    expect(screen.getByText("(estimated)")).toHaveAttribute(
      "title",
      "Part of this figure is estimated from average power over time, not read from an energy counter.",
    );
  });

  it("says so in words when the asset has no energy figure", () => {
    render(<EnergyTile energy={null} />);
    expect(screen.getByText("no energy data")).toBeInTheDocument();
    // words, not a measurement: the modifier lets the stylesheet set them small and muted instead of in the 28px figure style
    expect(screen.getByText("no energy data")).toHaveClass("big", "none");
  });

  it("mutes a figure that recorded nothing", () => {
    render(<EnergyTile energy={{ kwh: 0, estimated: false, no_data: true }} />);
    expect(screen.getByText("0.00 kWh")).toHaveClass("muted");
  });

  it("puts the energy icon beside the caption and leaves the caption text alone", () => {
    render(<EnergyTile energy={null} />);
    const caption = screen.getByText("Energy today");
    expect(caption).toHaveClass("muted", "tile-label");
    expect(caption.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(caption.querySelector("svg")!.innerHTML).toBe(iconHtml("energy"));
    expect(caption.parentElement!.firstElementChild).toBe(caption);
  });
});
