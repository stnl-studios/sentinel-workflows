CREATE PROCEDURE dbo.RebuildSynthetic
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    BEGIN TRY
        BEGIN TRANSACTION;
        IF EXISTS (SELECT 1 FROM dbo.Imported WITH (UPDLOCK, HOLDLOCK))
            THROW 51001, 'refuse rebuild: imported is not empty', 1;
        DELETE FROM dbo.ImportHistory;
        UPDATE dbo.Summary SET Total = 0 WHERE Id = 1;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
