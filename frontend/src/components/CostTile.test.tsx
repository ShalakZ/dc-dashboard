import { render, screen } from "@testing-library/react";
import { CostTile } from "./CostTile";
import { ESTIMATED_TIP, PARTIAL_TIP } from "./Figure";

describe("CostTile", () => {
  it("shows today's cost with the currency", () => {
    render(<CostTile cost={{ cost: 12.34, estimated: false, partial: false, no_data: false }} currency="QAR" />);
    expect(screen.getByText("Cost today")).toBeInTheDocument();
    expect(screen.getByText("12.34")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.queryByTitle(ESTIMATED_TIP)).not.toBeInTheDocument();
    expect(screen.queryByTitle(PARTIAL_TIP)).not.toBeInTheDocument();
    expect(screen.queryByTitle("no data")).not.toBeInTheDocument();
  });

  it("marks an estimated cost with ~ and a partial one with *, each with a tooltip", () => {
    render(<CostTile cost={{ cost: 0.39, estimated: true, partial: true, no_data: false }} currency="QAR" />);
    expect(screen.getByTitle(ESTIMATED_TIP)).toHaveTextContent("~");
    expect(screen.getByTitle(PARTIAL_TIP)).toHaveTextContent("*");
    expect(screen.getByText("0.39")).toBeInTheDocument();
  });

  it("shows a dash, never zero, when no rate applies (Review Focus 3, UI side)", () => {
    render(<CostTile cost={{ cost: null, estimated: false, partial: false, no_data: false }} currency="QAR" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("no rate set")).toBeInTheDocument();
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it("shows a dash when the asset has no energy figure at all", () => {
    render(<CostTile cost={null} currency="QAR" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("no cost data")).toBeInTheDocument();
  });

  it("says the currency is not set instead of guessing one", () => {
    render(<CostTile cost={{ cost: 3, estimated: false, partial: false, no_data: false }} currency={null} />);
    expect(screen.getByText("3.00")).toBeInTheDocument();
    expect(screen.getByText("currency not set")).toBeInTheDocument();
  });

  it("mutes a zero that only means nothing was recorded, and keeps it a number", () => {
    render(<CostTile cost={{ cost: 0, estimated: false, partial: false, no_data: true }} currency="QAR" />);
    const figure = screen.getByTitle("no data");
    expect(figure).toHaveClass("muted");
    expect(figure).toHaveTextContent("0.00");
  });

  it("does not mute a measured figure", () => {
    render(<CostTile cost={{ cost: 1, estimated: false, partial: false, no_data: false }} currency="QAR" />);
    expect(screen.getByText("1.00")).not.toHaveClass("muted");
  });
});
