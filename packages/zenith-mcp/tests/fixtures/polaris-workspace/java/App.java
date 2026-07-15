import java.util.ArrayList;
import static java.lang.Math.max;

public class PolarisApp {
    public int javaCompute(int n) {
        return javaHelper(n) + javaHelper(n);
    }

    private int javaHelper(int n) {
        return max(n, 0);
    }
}
