//
// Help! Evil alien creatures have hidden eggs all over the Earth
// and they're starting to hatch!
//
// Before you jump into battle, you'll need to know three things:
//
// 1. You can attach functions to structs (and other "type definitions"):
//
//     const Foo = struct{
//         pub fn hello() void {
//             std.debug.print("Foo says hello!\n", .{});
//         }
//     };
//
// 2. A function that is a member of a struct is "namespaced" within
//    that struct and is called by specifying the "namespace" and then
//    using the "dot syntax":
//
//     Foo.hello();
//
// 3. The NEAT feature of these functions is that if their first argument
//    is an instance of the struct (or a pointer to one) then we can use
//    the instance as the namespace instead of the type:
//
//     const Bar = struct{
//         pub fn a(self: Bar) void {}
//         pub fn b(this: *Bar, other: u8) void {}
//         pub fn c(bar: *const Bar) void {}
//     };
//
//    var bar = Bar{};
//    bar.a() // is equivalent to Bar.a(bar)
//    bar.b(3) // is equivalent to Bar.b(&bar, 3)
//    bar.c() // is equivalent to Bar.c(&bar)
//
//    Notice that the name of the parameter doesn't matter. Some use
//    self, others use a lowercase version of the type name, but feel
//    free to use whatever is most appropriate.
//
//    "But hold on," you say, eyeing a() and b() suspiciously, "why
//    does one take 'self' and another take '*self'?" Sharp eye!
//
//    It all comes down to a single question: does the function need
//    to CHANGE the struct?
//
//      * Needs to change it?  Take a pointer (*Bar). Without it you'd
//        be scribbling on a COPY, and your changes would evaporate the
//        instant the function returns. Poof.
//      * Only reads it?  Plain Bar is just fine.
//        (For a big, bulky struct you might still write *const Bar to
//        avoid copying it around, but for small ones a copy is cheap.)
//
//    You'll see this below: zap() takes 'self: HeatRay' by value
//    because it only reads the ray's damage, but it takes the alien
//    as '*Alien' because zapping is supposed to HURT - and that means
//    changing the alien's health for real, not on a throwaway copy.
//
// Okay, you're armed.
//
// Now, please zap the alien structs until they're all gone or
// the Earth will be doomed!
//
const std = @import("std");

// Look at this hideous Alien struct. Know your enemy!
const Alien = struct {
    health: u8,

    // We hate this method:
    pub fn hatch(strength: u8) Alien {
        return Alien{
            .health = strength * 5,
        };
    }
};

// Your trusty weapon. Zap those aliens!
const HeatRay = struct {
    damage: u8,

    // We love this method:
    pub fn zap(self: HeatRay, alien: *Alien) void {
        alien.health -= if (self.damage >= alien.health) alien.health else self.damage;
    }
};

pub fn main() void {
    // Look at all of these aliens of various strengths!
    var aliens = [_]Alien{
        Alien.hatch(2),
        Alien.hatch(1),
        Alien.hatch(3),
        Alien.hatch(3),
        Alien.hatch(5),
        Alien.hatch(3),
    };

    var aliens_alive = aliens.len;
    const heat_ray = HeatRay{ .damage = 7 }; // We've been given a heat ray weapon.

    // We'll keep checking to see if we've killed all the aliens yet.
    while (aliens_alive > 0) {
        aliens_alive = 0;

        // Loop through every alien by reference (* makes a pointer capture value)
        for (&aliens) |*alien| {

            // *** Zap the alien with the heat ray here! ***
            ???.zap(???);

            // If the alien's health is still above 0, it's still alive.
            if (alien.health > 0) aliens_alive += 1;
        }

        std.debug.print("{} aliens. ", .{aliens_alive});
    }

    std.debug.print("Earth is saved!\n", .{});
}
