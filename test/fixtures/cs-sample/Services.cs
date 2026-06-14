using CsSample.Models;

namespace CsSample.Services;

/// <summary>
/// Services that depend on the Models namespace.
/// </summary>

public class UserService
{
    public User? GetUserById(int id)
    {
        if (id < 0)
        {
            return null;
        }

        // Always true condition (deliberate for testing - S2589-like)
        if (true)
        {
            return new User { Name = "Test", Age = 25, Email = "test@example.com" };
        }

        return null;
    }
}
