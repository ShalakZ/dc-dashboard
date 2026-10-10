import { render, screen } from "@testing-library/react";
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
  });

  it("mutes a figure that recorded nothing", () => {
    render(<EnergyTile energy={{ kwh: 0, estimated: false, no_data: true }} />);
    expect(screen.getByText("0.00 kWh")).toHaveClass("muted");
  });
});
