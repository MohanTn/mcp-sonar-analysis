namespace CsSample.Models;

/// <summary>
/// Models namespace containing shared data structures.
/// This file deliberately includes violations for testing.
/// </summary>

public class User
{
    public string Name { get; set; } = string.Empty;
    public int Age { get; set; }
    public string Email { get; set; } = string.Empty;
}

public class Product
{
    // S1481: Unused local variable (deliberate for testing)
    public void CalculatePrice(int quantity, decimal unitPrice)
    {
        var unused = quantity * 10;  // S1481: unused local variable
        var total = quantity * unitPrice;
        System.Console.WriteLine($"Total: {total}");
    }

    // S2486: Empty catch block (deliberate for testing)
    public void ProcessData()
    {
        try
        {
            // Some operation
            var x = 1 / 0;
        }
        catch (Exception)
        {
            // Empty catch block - S2486
        }
    }
}
